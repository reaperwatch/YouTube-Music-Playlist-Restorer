# YouTube Music Playlist Exporter & Restorer

Automated tools to export YouTube Music playlists to CSV format, and to convert CSV song exports back into YouTube Music playlists with batch processing and automatic state saving.

Chrome, Edge, Safari and Firefox are natively supported.
Brave, Vivaldi, and Opera/GX MAY not work on Linux (try anyways, stop using Opera please).

---

## 1. Installation

Ensure you have **Node.js** installed with npm, then run (MUST BE inside the `youtubeApi` folder first before running it: cd pathto/youtubeApi/, for all scripts as well!):

```bash
npm install

```

---

## 2. Setup

1. **Log in:** Make sure you are logged into [YouTube Music](https://music.youtube.com) or [YouTube](https://youtube.com) on the browser.

2. **Add CSVs:** If you are restoring a playlist, drop your `.csv` file(s) into the `youtubeApi` folder of this project.

---

## 3. Usage

### Export a Playlist to CSV

Run the exporter script to scrape an existing YouTube playlist and save it as a local CSV file containing the title, artist, URL, and video ID:

```bash
node src/yt-to-csv.js

```

- The script will prompt you to enter the YouTube Playlist URL or ID.

- It will automatically paginate through the playlist and save the output as `Internal_Export_<ID>.csv`.

### Create a New Playlist

Run the main script to select a CSV, create the YouTube playlist, and automatically batch add all tracks:

```bash
node .

```

or

```bash
node src/yt-csv-to-playlist.js

```

- If multiple CSVs exist, you'll be prompted to pick one.

- Progress and playlist state are automatically updated in `restore_state.json` after every batch.

### Resume Interrupted Tasks

If your script crashes, the terminal closes, or rate limits stop the process, resume anytime from where you left off without creating duplicate playlists:

```bash
node src/resumer.js

```
