"""Signed-in account management: display name, password, email and deletion.

Lives under /account rather than /auth so the frontend can treat a 401 from here
as an expired session. For the same reason a wrong current password is a 400.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from auth import (
    EMAIL_CHANGE_TOKEN_EXPIRE_MINUTES,
    create_email_change_token,
    get_current_user,
    get_password_hash,
    verify_password,
)
from database import (
    get_db,
    LearningProgress,
    LessonSession,
    Playlist,
    PlaylistVideo,
    PracticeWordState,
    Sentence,
    User,
    UserConfig,
    Video,
)
from routers.auth import (
    EMAIL_TAKEN,
    TokenResponse,
    UserResponse,
    app_base_url,
    check_password,
    normalize_email,
    rate_limit,
    require_auth_enabled,
    token_response,
    user_response,
)
from services.audio_files import remove_unreferenced_audio
from services.mailer import send_email_change_confirmation
from services.qdrant_client import delete_vectors_for_user

router = APIRouter(dependencies=[Depends(require_auth_enabled)])

MAX_DISPLAY_NAME_LENGTH = 50


class ProfileBody(BaseModel):
    display_name: str | None = None

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, v: str | None) -> str | None:
        # Collapses runs of whitespace too, so a name can't hide line breaks.
        v = " ".join((v or "").split())
        if len(v) > MAX_DISPLAY_NAME_LENGTH:
            raise ValueError(f"Name must be at most {MAX_DISPLAY_NAME_LENGTH} characters")
        return v or None


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str

    _new_password = field_validator("new_password")(check_password)


class ChangeEmailBody(BaseModel):
    new_email: str
    current_password: str

    _new_email = field_validator("new_email")(normalize_email)


class DeleteAccountBody(BaseModel):
    password: str


def _require_password(user: User, password: str) -> None:
    """Re-check the password before a change that could lock the owner out."""
    rate_limit(f"password-check:{user.id}", limit=10, window_seconds=15 * 60)
    if not verify_password(password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )


@router.patch("/account", response_model=UserResponse)
async def update_profile(
    body: ProfileBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current_user.display_name = body.display_name
    db.commit()
    db.refresh(current_user)
    return user_response(current_user)


@router.post("/account/password", response_model=TokenResponse)
async def change_password(
    body: ChangePasswordBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_password(current_user, body.current_password)
    if body.new_password == body.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The new password must be different from the current one",
        )
    current_user.hashed_password = get_password_hash(body.new_password)
    db.commit()
    db.refresh(current_user)
    # Every token issued under the old password is now invalid, this session's
    # included, so hand it a fresh one; other devices have to sign in again.
    return token_response(current_user)


@router.post("/account/email")
async def request_email_change(
    body: ChangeEmailBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mails a confirmation link to the new address. The email only changes once
    that link is confirmed (POST /auth/confirm-email-change), so a mistyped
    address can't cut the account off from password recovery."""
    _require_password(current_user, body.current_password)
    if body.new_email == current_user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That is already your email address",
        )
    if db.query(User).filter(User.email == body.new_email).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_TAKEN)
    # Each request mails an address the user merely typed in.
    rate_limit(f"email-change:{current_user.id}", limit=5, window_seconds=3600)

    token = create_email_change_token(current_user, body.new_email)
    # In the fragment so the token never reaches server or proxy logs.
    confirm_url = f"{app_base_url()}/confirm-email#token={token}"
    background_tasks.add_task(
        send_email_change_confirmation,
        body.new_email,
        confirm_url,
        EMAIL_CHANGE_TOKEN_EXPIRE_MINUTES,
    )
    return {"message": "Confirmation link sent.", "email": body.new_email}


def _delete_user_rows(db: Session, user_id: int) -> list[str]:
    """Delete the user and every row they own, children before parents so it
    also works on databases that enforce foreign keys. Returns the paths of
    their audio files, to remove once the transaction has committed."""
    video_ids = select(Video.id).where(Video.user_id == user_id)
    playlist_ids = select(Playlist.id).where(Playlist.user_id == user_id)
    audio_paths = [
        path
        for (path,) in db.query(Video.audio_file_path).filter(
            Video.user_id == user_id, Video.audio_file_path.isnot(None)
        )
    ]

    def purge(model, condition) -> None:
        db.query(model).filter(condition).delete(synchronize_session=False)

    purge(PlaylistVideo, or_(PlaylistVideo.playlist_id.in_(playlist_ids), PlaylistVideo.video_id.in_(video_ids)))
    purge(LearningProgress, LearningProgress.user_id == user_id)
    purge(LessonSession, LessonSession.user_id == user_id)
    purge(PracticeWordState, PracticeWordState.user_id == user_id)
    purge(Sentence, Sentence.video_id.in_(video_ids))
    purge(Video, Video.user_id == user_id)
    purge(Playlist, Playlist.user_id == user_id)
    purge(UserConfig, UserConfig.user_id == user_id)
    purge(User, User.id == user_id)
    return audio_paths


@router.post("/account/delete")
async def delete_account(
    body: DeleteAccountBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete the account with all its lessons, progress and keys."""
    _require_password(current_user, body.password)
    user_id = current_user.id
    audio_paths = _delete_user_rows(db, user_id)
    db.commit()

    # Outside the transaction: files and vectors can't be rolled back, so they
    # go only once the rows are really gone. A file another account's copy of
    # the same lesson still plays is left in place.
    remove_unreferenced_audio(db, audio_paths)
    background_tasks.add_task(delete_vectors_for_user, user_id)
    return {"message": "Account deleted."}
