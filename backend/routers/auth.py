import os
import re
import time
from collections import defaultdict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
from auth import (
    RESET_TOKEN_EXPIRE_MINUTES,
    create_reset_token,
    create_user_token,
    get_current_user,
    get_password_hash,
    verify_email_change_token,
    verify_password,
    verify_reset_token,
)
from database import get_db, User
from services.mailer import send_email_changed_notice, send_password_reset

router = APIRouter()

MIN_PASSWORD_LENGTH = 8
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
EMAIL_TAKEN = "An account with this email already exists"


def normalize_email(v: str) -> str:
    v = (v or "").strip().lower()
    if len(v) > 254 or not _EMAIL_RE.match(v):
        raise ValueError("Enter a valid email address")
    return v


def check_password(v: str) -> str:
    if len(v) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(v) > 256:
        raise ValueError("Password is too long")
    return v


class Credentials(BaseModel):
    email: str
    password: str

    _email = field_validator("email")(normalize_email)


class RegisterBody(Credentials):
    _password = field_validator("password")(check_password)


class ForgotPasswordBody(BaseModel):
    email: str

    _email = field_validator("email")(normalize_email)


class ResetPasswordBody(BaseModel):
    token: str
    new_password: str

    _password = field_validator("new_password")(check_password)


class ConfirmEmailChangeBody(BaseModel):
    token: str


class UserResponse(BaseModel):
    id: int
    email: str | None
    display_name: str | None
    is_superuser: bool
    created_at: str | None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_superuser=bool(user.is_superuser),
        created_at=user.created_at.isoformat() if user.created_at else None,
    )


def token_response(user: User) -> TokenResponse:
    return TokenResponse(access_token=create_user_token(user), user=user_response(user))


def require_auth_enabled() -> None:
    if not auth.AUTH_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Accounts are not enabled")


def app_base_url() -> str:
    """Public address of the web app, for the links we put in emails."""
    return os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")


# In-memory attempt counters. Enough to blunt password guessing and mail spam
# on a single server process; they reset on restart.
_attempts: dict[str, list[float]] = defaultdict(list)


def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    recent = [t for t in _attempts[key] if now - t < window_seconds]
    if len(recent) >= limit:
        _attempts[key] = recent
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again later.",
        )
    recent.append(now)
    _attempts[key] = recent


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.get("/auth/config")
async def auth_config():
    """Tells the frontend whether to show the sign-in flow at all."""
    return {"auth_enabled": auth.AUTH_ENABLED}


@router.post("/auth/register", response_model=TokenResponse, dependencies=[Depends(require_auth_enabled)])
async def register(body: RegisterBody, request: Request, db: Session = Depends(get_db)):
    rate_limit(f"register:{client_ip(request)}", limit=10, window_seconds=3600)
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_TAKEN)

    hashed = get_password_hash(body.password)
    is_first_account = db.query(User).filter(User.email.isnot(None)).first() is None
    default_user = db.query(User).filter(User.username == "default", User.email.is_(None)).first()
    if is_first_account and default_user:
        # The first account takes over the pre-login "default" user in place, so
        # the data collected before accounts existed (and its vectors in Qdrant,
        # keyed by this id) comes along without being moved. Only the first: a
        # default user recreated after that account was deleted is left alone.
        user = default_user
        user.email = body.email
        user.hashed_password = hashed
    else:
        user = User(
            # username is a legacy unique column; the email is the identity now.
            username=body.email,
            email=body.email,
            hashed_password=hashed,
            is_superuser=is_first_account,
        )
        db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Lost a race with another sign-up for the same address.
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_TAKEN)
    db.refresh(user)
    return token_response(user)


@router.post("/auth/login", response_model=TokenResponse, dependencies=[Depends(require_auth_enabled)])
async def login(body: Credentials, request: Request, db: Session = Depends(get_db)):
    rate_limit(f"login:{client_ip(request)}:{body.email}", limit=10, window_seconds=15 * 60)
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )
    return token_response(user)


@router.get("/auth/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return user_response(current_user)


@router.post("/auth/forgot-password", dependencies=[Depends(require_auth_enabled)])
async def forgot_password(
    body: ForgotPasswordBody,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    rate_limit(f"forgot-ip:{client_ip(request)}", limit=10, window_seconds=3600)
    # Same response whether or not the address has an account, so this endpoint
    # can't be used to find out who is registered.
    response = {"message": "If that email is registered, we sent a link to reset the password."}
    try:
        rate_limit(f"forgot:{body.email}", limit=3, window_seconds=3600)
    except HTTPException:
        return response

    user = db.query(User).filter(User.email == body.email).first()
    if user:
        # In the fragment so the token never reaches server or proxy logs.
        reset_url = f"{app_base_url()}/reset-password#token={create_reset_token(user)}"
        background_tasks.add_task(send_password_reset, user.email, reset_url, RESET_TOKEN_EXPIRE_MINUTES)
    return response


@router.post("/auth/reset-password", dependencies=[Depends(require_auth_enabled)])
async def reset_password(body: ResetPasswordBody, request: Request, db: Session = Depends(get_db)):
    rate_limit(f"reset:{client_ip(request)}", limit=20, window_seconds=3600)
    user = verify_reset_token(body.token, db)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link is invalid or has expired. Request a new one.",
        )
    # Changing the hash also invalidates this token and every existing session.
    user.hashed_password = get_password_hash(body.new_password)
    db.commit()
    return {"message": "Password updated. You can now sign in."}


@router.post("/auth/confirm-email-change", dependencies=[Depends(require_auth_enabled)])
async def confirm_email_change(
    body: ConfirmEmailChangeBody,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Second half of POST /account/email. Takes no session: the emailed link may
    be opened in a browser that isn't signed in."""
    rate_limit(f"confirm-email:{client_ip(request)}", limit=20, window_seconds=3600)
    verified = verify_email_change_token(body.token, db)
    if not verified:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This confirmation link is invalid or has expired. Request the change again in Settings.",
        )
    user, new_email = verified
    if db.query(User).filter(User.email == new_email, User.id != user.id).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_TAKEN)

    old_email = user.email
    user.email = new_email
    if user.username == old_email:
        # Keep the legacy unique column in step, or the old address could never
        # be registered again.
        user.username = new_email
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_TAKEN)
    if old_email:
        background_tasks.add_task(send_email_changed_notice, old_email, new_email)
    return {"message": "Email address updated.", "email": new_email}
