# ARYZEN Media Downloader 3 - Project Context

ARYZEN Media Downloader 3 is a universal media downloader designed to easily save videos and audio from various platforms directly to your local machine.

## Overview
This project bridges a browser extension with a local host application to provide a seamless downloading experience.

## Key Components
- **Browser Extension**: Injects a floating "Download" button into supported web pages (YouTube, Instagram, Reddit, Twitch, SoundCloud, Streamable, TED). It includes a quality picker to let users choose their preferred format.
- **Local Bridge (`bridge/umd_host.py`)**: Acts as a native messaging host that communicates with the browser extension and executes the download tasks.
- **Download Engine**: Leverages `yt-dlp` to fetch media.
- **Processing**: Utilizes `FFmpeg` for merging video/audio and converting formats (e.g., to MP3).
- **JavaScript Runtime**: `Deno` is used to handle specific challenges posed by platforms like YouTube.

## How it works
1. The user clicks the floating download button in their browser.
2. The extension sends a request to the local `bridge/umd_host.py`.
3. The bridge uses `yt-dlp` and `FFmpeg` to download and process the media.
4. The final file is saved to the user's local Downloads folder.

This architecture ensures that the application operates directly on the user's computer without requiring a hosted backend service, ensuring privacy and no tracking.

## Technical Stack
- **Browser Extension**: JavaScript, CSS, HTML.
- **Bridge/Backend**: Python (`umd_host.py`).
- **External Tools (Integrated/Downloaded)**: `yt-dlp`, `FFmpeg`, `Deno`.

## Project Structure
- `/extension`: Browser extension source code.
- `/bridge`: Local Python host script and configuration.
- `/assets`: Branding, icons, diagrams, and screenshots.
- `/install`: Installation scripts for various OSs.
- `/tests`: Integration and regression tests.
