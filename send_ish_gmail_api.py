#!/usr/bin/env python3
import os
import sys
import base64
import time
import urllib.parse
import subprocess
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]
TOKEN_FILE = "/Users/louislapat/vibe/google/skyline auto/credentials/gmail_send_token.json"
CREDS_FILE = "/Users/louislapat/vibe/google/skyline auto/credentials/gmail_credentials.json"
RECIPIENT_EMAIL = "iskanderb@gmail.com"
CC_EMAIL = "louislapat@gmail.com"
SUBJECT = "⚡ BetBot v3.4 Update: In-Extension Tagger, Auto-Username Handshake, 900+ Data Points & Fighter Playbook"

EMAIL_BODY_TEXT = """Hey Ish,

Here is the updated build (v3.4) and the complete breakdown of the new features we engineered today across LiveBetBot and the DraftKings extension:

============================================================
1. DOWNLOAD EXTENSION V3.4 (Zero-Drop 900+ Data Points)
============================================================
• Google Drive Public Link:
  https://drive.google.com/file/d/1Dh48s_-tsKtvfSyY-S_SNxURIifwwv0g/view?usp=sharing

• Direct 1-Click Server Download (No Google Login Required):
  https://www.livebetbot.com/download/bet-bot-dk-sync.zip

To install: download, unzip, go to chrome://extensions, and click the circular reload icon on BetBot.

============================================================
2. WHAT WAS BUILT FOR YOU:
============================================================
1. In-Extension Live Tagger (No More Tab Switching):
   You can now tag fighters directly from the Chrome extension popup while looking at DraftKings!
   • Dedicated [🐕 Raw Dog] buttons for your gut-feel picks.
   • Quick-tag pills for all 8 traits: Heavy Wrestler, Takedown Defense, Striking Power, Efficient Striker, Age Cliff (35+), Size Advantage, Cardio Machine, and Bad Tank.
   • Live line-flip edge calculates right inside the popup!

2. Automatic 2-Way Username Handshake:
   You never have to worry about typing your username in two places again.
   • If you set your username on LiveBetBot, the extension automatically adopts it.
   • If you set it in the extension, LiveBetBot automatically syncs.
   • Both stay 100% locked in sync so your bets always appear on screen.

3. 30-Second In-Popup Cheat Sheet:
   Whenever you need a refresher on fight night, just tap the new [? How It Works] button in the extension header. It drops down a visual 3-step cheat sheet right on your screen.

4. Illustrated Fighter Playbook:
   Check out the new playbook at:
   👉 https://www.livebetbot.com/guide
   Explains all 8 stylistic tags, real fighter examples, the Raw Dog rule, and the 1-click Auto-Snipe latency edge.

5. Direct ESPN Athlete Profiles on Tape Page:
   Every fighter on https://www.livebetbot.com/tape now has a direct [🔴 ESPN Profile ↗] button to view their official profile with one tap.

6. Guaranteed 900+ Data Point Capture:
   We replaced standard browser timers with an isolated Web Worker, ensuring Chrome will NEVER throttle or sleep your odds recording tab in the background.

Best,
Louis"""

def get_gmail_service():
    creds = None
    if os.path.exists(TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
                with open(TOKEN_FILE, "w") as token:
                    token.write(creds.to_json())
        except Exception as e:
            print(f"Token refresh failed: {e}")
            creds = None

    if not creds or not creds.valid:
        if os.path.exists(CREDS_FILE):
            print("Initiating local OAuth server flow (opening browser for approval)...")
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0, open_browser=True)
            with open(TOKEN_FILE, "w") as token:
                token.write(creds.to_json())
            print(f"✅ Fresh token saved to {TOKEN_FILE}")
        else:
            raise FileNotFoundError(f"OAuth credentials not found at {CREDS_FILE}")

    return build("gmail", "v1", credentials=creds)

def open_gmail_compose_fallback():
    params = urllib.parse.urlencode({
        'view': 'cm',
        'fs': '1',
        'to': RECIPIENT_EMAIL,
        'su': SUBJECT,
        'body': EMAIL_BODY_TEXT
    })
    url = f"https://mail.google.com/mail/?{params}"
    script = f'''
    tell application "Google Chrome"
      tell window 1
        make new tab with properties {{URL:"{url}"}}
      end tell
      activate
    end tell
    '''
    subprocess.run(['osascript', '-e', script])

def main():
    try:
        print("Connecting to Gmail API...")
        service = get_gmail_service()
        
        message = MIMEMultipart("alternative")
        message["to"] = RECIPIENT_EMAIL
        message["cc"] = CC_EMAIL
        message["subject"] = SUBJECT
        message.attach(MIMEText(EMAIL_BODY_TEXT, "plain", "utf-8"))

        raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
        body = {"raw": raw_message}

        sent = service.users().messages().send(userId="me", body=body).execute()
        print("=" * 80)
        print("🎉 SUCCESS: Email delivered to Ish via Gmail API!")
        print(f"  To:         {RECIPIENT_EMAIL}")
        print(f"  Subject:    {SUBJECT}")
        print(f"  Message ID: {sent.get('id')}")
        print("=" * 80)
    except Exception as e:
        print(f"⚠️ Gmail API send error: {e}")
        print("Falling back to opening pre-filled Gmail Compose window in Chrome...")
        open_gmail_compose_fallback()
        print("✓ Pre-filled draft opened in Chrome.")

if __name__ == "__main__":
    main()
