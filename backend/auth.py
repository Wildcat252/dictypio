import hashlib
import os
from datetime import datetime, timedelta
from typing import Optional, Tuple

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import get_db, User

# Accounts are opt-in: the web deployment sets AUTH_ENABLED, while the desktop
# app leaves it off and every request runs as the local default user.
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "").strip().lower() in ("1", "true", "yes")

security = HTTPBearer(auto_error=False)

_DEV_SECRET = "ear2finger-dev-secret-change-in-production"
SECRET_KEY = os.getenv("SECRET_KEY", "").strip() or _DEV_SECRET
if AUTH_ENABLED and SECRET_KEY == _DEV_SECRET:
    # Tokens signed with the published dev key could be forged by anyone.
    raise RuntimeError("AUTH_ENABLED requires SECRET_KEY to be set to a private random value")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days
RESET_TOKEN_EXPIRE_MINUTES = 30
EMAIL_CHANGE_TOKEN_EXPIRE_MINUTES = 30

# pbkdf2_sha256 for new hashes; bcrypt so the default user created by
# migrate_db can still be verified.
pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except ValueError:
        return False


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def password_fingerprint(user: User) -> str:
    """Changes whenever the password does, so tokens carrying it expire with the old password."""
    return hashlib.sha256((user.hashed_password or "").encode()).hexdigest()[:16]


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_user_token(user: User) -> str:
    return create_access_token({"sub": str(user.id), "pwd": password_fingerprint(user)})


def create_reset_token(user: User) -> str:
    return create_access_token(
        {"sub": str(user.id), "pwd": password_fingerprint(user), "purpose": "reset"},
        expires_delta=timedelta(minutes=RESET_TOKEN_EXPIRE_MINUTES),
    )


def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def _user_from_payload(payload: Optional[dict], db: Session) -> Optional[User]:
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if not user or payload.get("pwd") != password_fingerprint(user):
        return None
    return user


def verify_reset_token(token: str, db: Session) -> Optional[User]:
    """The user a reset token belongs to, or None if it is invalid, expired or already used."""
    payload = decode_token(token)
    if not payload or payload.get("purpose") != "reset":
        return None
    return _user_from_payload(payload, db)


def create_email_change_token(user: User, new_email: str) -> str:
    return create_access_token(
        {
            "sub": str(user.id),
            "pwd": password_fingerprint(user),
            "purpose": "email-change",
            # Tied to the address being replaced, so the link stops working once
            # the email has changed, whether through this link or a later one.
            "old": user.email,
            "new": new_email,
        },
        expires_delta=timedelta(minutes=EMAIL_CHANGE_TOKEN_EXPIRE_MINUTES),
    )


def verify_email_change_token(token: str, db: Session) -> Optional[Tuple[User, str]]:
    """The user and their confirmed new email, or None if the link is invalid, expired or already used."""
    payload = decode_token(token)
    if not payload or payload.get("purpose") != "email-change":
        return None
    user = _user_from_payload(payload, db)
    new_email = payload.get("new")
    if not user or not new_email or user.email != payload.get("old"):
        return None
    return user, new_email


def get_default_user(db: Session) -> User:
    user = db.query(User).filter(User.username == "default").first()
    if not user:
        user = User(
            username="default",
            hashed_password=get_password_hash("default"),
            is_superuser=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if not AUTH_ENABLED:
        return get_default_user(db)

    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not credentials or not credentials.credentials:
        raise unauthorized
    payload = decode_token(credentials.credentials)
    # A reset token must not double as a login session.
    if not payload or payload.get("purpose"):
        raise unauthorized
    user = _user_from_payload(payload, db)
    if not user:
        raise unauthorized
    return user


async def get_current_superuser(
    current_user: User = Depends(get_current_user),
) -> User:
    """Require that the current user is a superuser."""
    if not getattr(current_user, "is_superuser", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Superuser privileges required",
        )
    return current_user
