"""Outgoing email over SMTP, configured through SMTP_* environment variables."""
import os
import smtplib
from email.message import EmailMessage
from html import escape

APP_NAME = "Dictypio"


def _send(to_email: str, subject: str, text: str, html: str) -> None:
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        # No mail server in local development: the log is the inbox.
        print(f"[mailer] SMTP_HOST not set; email to {to_email} not sent.\n{text}")
        return

    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.getenv("SMTP_FROM", "").strip() or user
    msg["To"] = to_email
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=20)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
    with server:
        if port != 465:
            server.starttls()
        if user:
            server.login(user, password)
        server.send_message(msg)


def _send_in_background(to_email: str, subject: str, text: str, html: str) -> None:
    """These all run as background tasks, after the response has gone out, so a
    failure can only be logged."""
    try:
        _send(to_email, subject, text, html)
    except Exception as e:
        print(f"[mailer] Could not send \"{subject}\" to {to_email}: {e}")


def send_password_reset(to_email: str, reset_url: str, expires_minutes: int) -> None:
    text = (
        f"Someone asked to reset the password for your {APP_NAME} account.\n\n"
        f"Open this link to choose a new password (valid for {expires_minutes} minutes):\n"
        f"{reset_url}\n\n"
        "If this wasn't you, you can ignore this email; your password stays the same."
    )
    link = escape(reset_url, quote=True)
    html = (
        f"<p>Someone asked to reset the password for your {APP_NAME} account.</p>"
        f'<p><a href="{link}">Choose a new password</a> '
        f"(link valid for {expires_minutes} minutes).</p>"
        "<p>If this wasn't you, you can ignore this email; your password stays the same.</p>"
    )
    _send_in_background(to_email, f"Reset your {APP_NAME} password", text, html)


def send_email_change_confirmation(to_email: str, confirm_url: str, expires_minutes: int) -> None:
    """Sent to the NEW address: the change only happens once its owner opens the link."""
    text = (
        f"Someone asked to use this address for their {APP_NAME} account.\n\n"
        f"Open this link to confirm it (valid for {expires_minutes} minutes):\n"
        f"{confirm_url}\n\n"
        "If this wasn't you, you can ignore this email; nothing will change."
    )
    link = escape(confirm_url, quote=True)
    html = (
        f"<p>Someone asked to use this address for their {APP_NAME} account.</p>"
        f'<p><a href="{link}">Confirm this email address</a> '
        f"(link valid for {expires_minutes} minutes).</p>"
        "<p>If this wasn't you, you can ignore this email; nothing will change.</p>"
    )
    _send_in_background(to_email, f"Confirm your new {APP_NAME} email", text, html)


def send_email_changed_notice(old_email: str, new_email: str) -> None:
    """Sent to the OLD address, so its owner hears about a change they didn't make."""
    text = (
        f"The email address of your {APP_NAME} account was changed to {new_email}.\n\n"
        f"From now on you sign in with {new_email}; this address no longer works.\n\n"
        "If you didn't make this change, someone else has access to your account."
    )
    html = (
        f"<p>The email address of your {APP_NAME} account was changed to "
        f"<strong>{escape(new_email)}</strong>.</p>"
        f"<p>From now on you sign in with {escape(new_email)}; this address no longer works.</p>"
        "<p>If you didn't make this change, someone else has access to your account.</p>"
    )
    _send_in_background(old_email, f"Your {APP_NAME} email was changed", text, html)
