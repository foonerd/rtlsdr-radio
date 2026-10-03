# FM/DAB Radio Plugin for Volumio

Receive FM and DAB/DAB+ radio using RTL-SDR USB tuners.

## Hardware Requirements

- RTL-SDR USB dongle (RTL2832U chipset)
- Compatible with R820T, R820T2, R828D, E4000 tuners
- Quality dongles recommended: Nooelec NESDR Smart, RTL-SDR Blog V3/V4
- Cheap generic blue dongles work but may require PPM frequency correction for DAB
- Antenna suitable for FM (76-108 MHz depending on region) and/or DAB Band III (174-240 MHz)

## Supported Platforms

- Raspberry Pi (armhf, arm64)
- x86/x64 systems (amd64)
- Volumio 4.x (Bookworm)

## Features

### Radio Reception
- FM radio reception (76-108 MHz, configurable lower bound for regional bands)
- DAB and DAB+ digital radio
- Automatic station scanning with configurable sensitivity
- Integrated with Volumio's playback system
- Volume control through Volumio
- Real-time signal quality indicator (5-level display)

### Station Management
- Web-based station management interface
- Mark stations as favorites
- Hide unwanted stations
- Custom station naming
- Search and filter stations
- Recycle bin for deleted stations (recoverable)
- Per-row save buttons for quick edits
- Bulk operations (clear all, rescan)
- CSV import/export for offline editing

### Multilingual Support
The plugin fully supports internationalization with automatic language detection:
- Plugin settings interface displays in your selected Volumio language
- Web management interface automatically follows Volumio's language setting
- No manual configuration required

**Supported Languages:**
- English
- German (Deutsch)
- Spanish (Espanol)
- French (Francais)
- Italian (Italiano)
- Japanese (日本語)
- Dutch (Nederlands)
- Polish (Polski)
- Portuguese (Portugues)
- Russian (Русский)
- Chinese Simplified (简体中文)

To change language: Settings > Appearance > Language. Both plugin settings and web manager will update automatically.

### Backup and Restore
The plugin includes a comprehensive backup and restore system to protect your configurations:

**Features:**
- Four backup types: Stations, Configuration, Block List, or Full Backup
- Automatic pruning (keeps 5 most recent backups per type)
- Download backups as ZIP files
- Upload and restore external backups
- Mix-and-match restore (stations from one backup, config from another, blocklist from another)
- Optional auto-backup before plugin uninstall
- Backup history with timestamps and sizes

**Backup Types:**
- **Stations**: FM and DAB station database (favorites, custom names, play counts), together with the logos you chose for stations yourself
- **Configuration**: Plugin settings (gain, PPM, scan sensitivity, artwork settings)
- **Block List**: Artwork blocklist phrases
- **Full**: All of the above

**Location:**
- Access via Maintenance tab in web station manager
- Backups stored in: `/data/rtlsdr_radio_backups/`
  - `/data/rtlsdr_radio_backups/stations/`
  - `/data/rtlsdr_radio_backups/config/`
  - `/data/rtlsdr_radio_backups/blocklist/`

**Usage:**
1. Open web station manager (see Web Interface Access below)
2. Click "Maintenance" tab
3. Select backup type and click "Create Backup Now"
4. Download backups or restore from history table (three columns: Stations, Config, Block List)

**Last good copy:**
Whenever the plugin stops, and so before every update or uninstall, the current station list and block list are copied to the backup folder. A later install finds them there and restores them when it has no list of its own. Backups are preserved even after uninstall.

With "Auto-backup before uninstall" selected, uninstalling the plugin also writes a dated backup of the station list, the block list and the settings, listed in the Station Manager after the next install like any other backup, and keeps the station logos.

### CSV Import/Export

Edit your stations offline using standard CSV files. Useful for bulk editing, sharing station lists between systems, or pre-configuring before hardware arrives.

**Features:**
- Download FM and DAB templates with headers and example data
- Export existing stations with timestamps
- Four import operations for flexible station management
- Validation before import with detailed error reporting
- Respects regional FM frequency settings

**Import Operations:**

| Operation | Description |
|-----------|-------------|
| Replace | Clear all stations of type and import fresh from CSV |
| Amend | Update existing stations, preserve play history |
| Extend | Add new stations only, skip duplicates |
| Remove | Mark matching stations as deleted |

**CSV Format:**

FM stations:
```csv
frequency,name,customName,favorite,hidden,notes
94.9,BBC Radio London,My BBC,true,false,Optional notes
```

DAB stations:
```csv
channel,exactName,name,customName,ensemble,serviceId,favorite,hidden,notes
12C,BBC Radio 1,BBC Radio 1,,London 1,0,true,false,Optional notes
```

**Usage:**
1. Open web station manager
2. Click "Maintenance" tab
3. Scroll to "Import / Export Stations" section
4. Download template or export existing stations
5. Edit CSV in spreadsheet application
6. Upload, validate, select operation, and import

**Notes:**
- DAB `exactName` must match exactly (including trailing spaces)
- FM frequency range respects your regional setting (Japan 76MHz, Italy 87MHz, etc.)
- Validation shows line-by-line errors before import
- AMEND preserves playCount, lastPlayed, and dateAdded fields

### Best Effort Artwork

Radio broadcasts include metadata (RDS on FM, DLS on DAB) that often contains artist and title information. The plugin attempts to parse this metadata and fetch matching album artwork from Last.fm.

This is called "Best Effort" because broadcast metadata is inconsistent - stations format it differently, RDS has bit errors, and non-music content (adverts, news, DJ chat) gets mixed in. The plugin uses multiple strategies to maximise artwork success rate while minimising false matches.

**How It Works:**

1. Broadcast metadata arrives (e.g., "Playing: Dua Lipa - Levitating")
2. Plugin parses text to extract artist and title
3. Parser assigns confidence score based on pattern quality
4. If confidence meets threshold, Last.fm lookup is triggered
5. Artwork cached locally for instant display on repeat plays

**When Artwork Won't Appear:**

- Station doesn't broadcast metadata (some stations transmit only station name)
- Metadata is non-music content (news, adverts, DJ speech)
- Confidence score below threshold (ambiguous format)
- Track not in Last.fm database
- Phrase matches blocklist (traffic updates, time checks)

**Training the System:**

The blocklist is your primary tool for improving accuracy. When you see wrong artwork:

1. Note what text triggered the false match (check logs if needed)
2. Open Station Manager > Block List tab
3. Add the problematic phrase
4. Save - future broadcasts containing that phrase are skipped

Common additions: DJ names, show titles, station slogans, local business adverts.

**Settings Guide (Plugin Settings > Artwork Settings):**

| Setting | Purpose | Recommendation |
|---------|---------|----------------|
| Best Effort Artwork | Master on/off for all artwork features | ON unless headless system |
| Confidence Threshold | How certain parser must be before lookup | Start at 60%, lower if missing artwork, raise if false matches |
| Artwork Persistence | Keep artwork during metadata gaps | "Keep until artist changes" prevents flicker |
| Artwork Timeout | Auto-clear after N minutes | Use for audiobooks/talk radio, else Disabled |
| Artwork Cool-off | Shortest time a picture stays before another replaces it | 2 seconds; Off shows every change at once |
| Debug Logging | Verbose logs for troubleshooting | OFF unless debugging |

**Confidence Threshold Explained:**

- **0% (Always lookup)**: Attempts lookup on any parsed text. Maximum artwork, but more false matches.
- **60% (Default)**: Balanced. Requires reasonable "Artist - Title" pattern.
- **95% (Very high)**: Only clear, unambiguous patterns. Fewer false matches, but misses non-standard formats.

Adjust based on your stations. Music stations with clean metadata can use lower thresholds. Stations mixing music with speech benefit from higher thresholds.

**Artwork Persistence Explained:**

Radio metadata updates constantly. Between songs, stations often display promos, frequencies, or slogans. Without persistence, artwork would disappear and reappear, causing flicker.

- **Keep until artist changes**: Best for music stations. Artwork stays until a different artist is detected.
- **Keep until track changes**: More responsive, but may flicker on stations with inconsistent metadata.
- **Always refresh**: Updates on every metadata change. Use only if persistence causes stale artwork.

**When the picture changes:**

A station's text changes every few seconds: the song, a slogan, the presenter, the song again in other words. The picture on the screen follows the song, not the text:

- The song whose cover is shown, named again: nothing changes.
- A new song: the picture on the screen stays until the new cover has been found, and is then replaced by it. The station's logo is not shown in between.
- A song that is known and has no cover: the station's logo is shown, not the cover of the song before (unless covers are kept per artist and the artist is the same).
- A text that names no song, or a line read as artist and title that no music database knows (a presenter's line, for one): the picture stays, for as long as the persistence and timeout settings keep a cover.

**Artwork Cool-off Explained:**

A picture stays on the screen for at least the cool-off time (2 seconds unless set otherwise) before another takes its place. If several changes come within that time, the last one is shown when the time is up and the ones between are skipped. The text and the tune level are never held back, only the picture. How one picture gives way to the next on the screen (a cut, a fade) is the screen's own doing; the plugin hands it the picture to show.

**Artwork Timeout Explained:**

For spoken word content (audiobooks, talk radio, long DJ sets), the last song's artwork may persist indefinitely since no new "artist" is detected.

Setting a timeout (2-30 minutes) automatically reverts to the station icon when no artist change occurs. The timer resets each time a new artist is detected. A cover whose time is up leaves the screen with the next text that brings nothing to take its place; while a new song is being looked up it stays, so that one cover gives way to the next and not to the station's logo in between.

**Block List (Station Manager > Block List tab):**

Phrases in the blocklist are excluded from artwork lookup. The plugin uses fuzzy matching (75% similarity) so minor variations and RDS corruption are handled automatically.

Default blocklist includes: traffic update, news update, weather, breaking news, travel news.

Add station-specific phrases as you encounter false matches. The blocklist has separate backup/restore from stations.

### FM Scan

A scan measures every channel of the FM band and keeps the ones that are stations.

- The band is taken in slices of 2 MHz, each at its own gain: the highest at which the signal is not cut off and the tuner is not overloaded.
- A channel counts as a station when it holds more than the channels next to it, its carrier lies on the channel, the 19 kHz pilot every stereo station sends stands clear of the noise for the whole time it is listened to, and the pilot is still there when the gain is lowered.
- That last check tells stations from signals a tuner manufactures when a very strong station nearby overloads it. Such signals look like stations, pilot included, but go when the gain is lowered; a station does not.
- Each station found is given a reception level from 1 to 5, the same measure the player shows while a station plays.
- Stations received well enough for RDS (the pilot about 36 dB above the noise) are then listened to for up to four seconds each, for their RDS programme code. It is what a station's name and logo are found by. A station whose code is already kept is not listened to again; a weaker station tells its code while it is played.
- **FM Scan Sensitivity** (Settings > FM) is how far the pilot must stand above the noise, from +3 dB (faint stations too) to +15 dB (very strong ones only).
- Stations you named, marked as favourite, hid, deleted, added by hand or played stay as they are, whether the scan finds them or not.
- A station an earlier scan listed, that this scan looked for and did not find, and that you never touched, is removed. The scan says how many.
- A station that sends no stereo pilot (mono) is not found by the scan; it can be added by hand in the Station Manager.

The scan takes about half a minute on a Raspberry Pi 4 or 5, and a few seconds more for each station strong enough for RDS; longer on the slowest boards. What it measured is written to the player's log, slice by slice.

### Station Logos
DAB and FM stations are shown with their logo in the station lists, and on the player screen whenever the station has no artwork of its own to show.

**Where the logos come from:**

The logos are published by the broadcasters themselves and found through RadioDNS, the same service digital radios use. Nothing is taken from third-party collections.

- A station registered by its broadcaster is shown with its own logo.
- A station its broadcaster lists on other ensembles than the one you receive is recognised by its service identifier and shown with its own logo too.
- A station without a logo of its own is shown with its broadcaster's logo, when the broadcaster publishes one and the station carries the broadcaster's name (a local BBC station, for example).
- A station nobody publishes a logo for keeps the DAB icon.

**FM stations:**

A DAB station says what it is by the identifiers it transmits. An FM station does so only through RDS, and RDS needs better reception than listening does. So an FM station is found in two ways:

- By its RDS programme code (PI). The plugin keeps the code with the station once it has been received while the station plays, and looks the station up by it. The broadcaster's list also says what the station is called; a station still named "FM 98.5" takes that name.
- By its name, until the code is known and where RDS never comes: the name you gave the station, or the one RDS sends. It is looked for among your own DAB stations that have a logo, then in the broadcasters' lists. "Magic Radio" finds "Magic", "Classic" finds "Classic FM", "BBC Radio 2 National" finds "BBC Radio 2". A name that only begins like several stations ("Heart" with "Heart UK", "Heart 80s" and "Heart London" on DAB) takes the logo of the nearest of that family from your DAB stations.
- A logo found by name gives way to the one found by the programme code once RDS has told it.
- A station without a name and without RDS keeps the FM icon. Naming it in the Station Manager is what finds its logo.
- The name RDS sends is taken as the station's name only after it has stood unchanged for half a minute: some stations put running text there. A name you gave a station is never changed.

**A logo of your own (Station Manager):**

Every station in the FM and DAB lists shows its logo at the front of its row; a station without one shows an empty frame. The **No logo** card above each list counts those stations, and a press on it shows only them.

A press on a station's logo opens its logo dialog. It shows the logo in use and where it comes from, and offers three ways to change it:

- **Your own picture.** PNG, JPEG or SVG. Square, 600 × 600 pixels is ideal; up to 2 MB. The dialog shows the picture as it will look before anything is saved. A picture that is not square is fitted into a square (the whole picture, or filling the square and cropped to the centre); a larger one is scaled down to 600 × 600. Refused, with the reason: a file that is not a picture, a picture smaller than 128 pixels on a side (below 300 it is taken with a warning), and an SVG that contains script or refers to anything outside itself.
- **One of the broadcasters' logos.** A search by name among the services the broadcasters' lists name. The lists are those of the broadcasters you receive on DAB, so the choice is wide but not complete.
- **One of the logos already on the player.**

Your choice is shown everywhere in place of whatever is found for the station, and no refresh replaces it. **Back to automatic** returns the station to the logo found for it.

**When they are fetched:**

- In the background after the plugin starts and after a scan, and whenever a station without a logo is listed or played. The station being played is fetched first.
- Only when there is an internet connection. Without one (flight mode, hotspot mode, a network that is down) nothing is fetched, nothing is reported as an error, and fetching carries on by itself when the connection is back.
- A station without a published logo is asked about again after a week.

**Refreshing on demand (Station Manager > Maintenance > Station Logos):**

The section shows how many stations have a logo and whether fetching is under way. **Refresh Station Logos** asks again for every station without a logo, then checks the logos already kept for newer versions; pictures that have not changed are not downloaded again.

**Where they are kept:**

Logos, your own among them, are kept in `/data/rtlsdr_radio_logos` and survive plugin updates. Uninstalling the plugin removes them, unless *Auto-backup before uninstall* is selected, in which case they are kept for the next installation. A stations backup made in the Station Manager carries the logos you chose yourself (a picture you uploaded, or one you picked from the broadcasters' lists or from the player), and a restore puts them back, on this player or another. Logos fetched from the broadcasters are not in a backup: they are fetched again.

### Plugin Update
The plugin can be updated from the Station Manager (Maintenance > Plugin Update), without waiting for the player to offer the update.

**Channels:**

| Channel | Where the versions come from | For |
| --- | --- | --- |
| Stable | Volumio plugin store, released versions | everyday use |
| Beta | Volumio plugin store, versions in testing | trying a version before it is released |
| Preview | the project's pre-releases on GitHub | trying a version before it goes to the store; may have faults |

A channel includes the ones above it: Beta offers stable versions too, Preview offers whatever is newest.

**Which channel is in force is the player's to say.** Volumio has a switch for testing plugins: *Plugins Test Mode* on the player's `/dev` page (`http://<player>/dev`).

- Off, which is how a player comes: the plugin stays on Stable, whatever is chosen in the Station Manager.
- On: the channel chosen in the Station Manager applies, Beta or Preview.

Switching test mode off again puts the player back on Stable; nothing else has to be undone.

The section shows the installed version and the newest version the channel in force offers.

- The plugin store answers only players signed in to MyVolumio. A player that is not is still offered the stable version: the release on GitHub that is not a pre-release is the version that is stable in the store.
- A version from GitHub is downloaded by the plugin and checked against the size and SHA-256 checksum GitHub publishes for it. A download that does not match is discarded.

**What an update does:**

1. Backs up the station list, the settings and the block list.
2. Keeps the installed version as a zip.
3. Hands the new version to Volumio's own plugin manager, which installs it the way it installs any plugin update.
4. Restarts the player's software so that the new version is loaded.

Playback stops and the player is unavailable for about a minute. When it is back, the section says which version is running.

**Going back:** after an update, *Go Back to (version)* reinstalls the version that was installed before, the same way. One previous version is kept, in `/data/rtlsdr_radio_backups/update`.

### Antenna Positioning Tools
The plugin includes professional-grade tools for optimizing antenna placement and orientation:

**Tool 1: RF Spectrum Scan**
- Full-band spectrum analysis (87.5 MHz to 240 MHz)
- 2-second scan covering FM and DAB frequencies
- Visual signal strength display across entire spectrum
- Identify which frequencies have strong signals in your location
- Real-time feedback for antenna orientation adjustments

**Tool 2: DAB Channel Validation**
- Validate specific DAB channels for signal presence
- Progressive results via Server-Sent Events (displays results as each channel completes)
- Per-channel sync status and service count
- Quality assessment (excellent vs no signal)
- Typical validation time: 10-15 seconds per channel with signal, 2-3 seconds for no signal

**When to Use:**
- Before initial full scan to verify antenna reception
- Antenna positioning and orientation (rotating/tilting for best signal)
- Diagnosing reception problems
- Comparing antenna locations
- Verifying dongle functionality

**How to Use:**
1. Open web station manager (see Web Interface Access below)
2. Click "Antenna Positioning" tab
3. Tool 1: Click "Start Spectrum Scan" for full-band analysis
4. Tool 2: Select channels to validate, click "Validate Selected Channels"
5. View progressive results in real-time
6. Adjust antenna and re-test until optimal signal achieved

**Workflow Guide:**
1. Start with RF Spectrum Scan to see available frequencies
2. Use DAB Channel Validation to test specific channels
3. Adjust antenna position/orientation between tests
4. Repeat until signal strength is optimal
5. Perform full station scan once antenna is positioned

**Technical Details:**
- Spectrum scan uses fn-rtl_power for wide-band analysis
- Channel validation uses custom fn-dab-scanner binaries
- Progressive SSE streaming prevents long waits
- Three critical bugs fixed in v1.0.8 for accurate validation
- No signal channels terminate in 2-3 seconds (no timeout)
- Strong signal channels complete in 10-15 seconds

### Diagnostics Tools
The plugin includes diagnostic tools to test your USB dongle before scanning:

- **Purpose**: Verify your dongle can receive specific frequencies
- **When to use**: Station won't play, weak signal, testing new dongle
- **How**: Enter a known strong station, save settings, click test
- **Expected result**: You should hear audio

**Understanding Gain Settings**:
- Gain controls the RTL-SDR RF amplifier, affecting signal-to-noise ratio and overload threshold
- By default the plugin measures it: for FM once per station (kept for a week, then measured again), for DAB at every tuning. It sets the highest step at which the signal is not cut off in the receiver's converter
- For FM the tuner is checked for overload as well. A very strong station can overload it from outside the part of the band being received, without the converter showing it; the stations near it are then held down and signals appear that are not on the air. The part of the band in view is compared with how it looks at a gain 20 dB lower, where the tuner has room to spare, and the highest gain is taken at which it still looks the same
- "Automatic FM gain" and "Automatic DAB gain" in the settings switch this off; the gain set by hand is then used
- Setting it by hand: lower it if the audio is distorted or stations appear where there are none, raise it if there is no signal
- Note: This is RF amplification, not volume control

**Understanding PPM Correction** (DAB only):
- PPM corrects frequency error from cheap crystal oscillators
- **Quality dongles** (Nooelec, RTL-SDR Blog V3/V4): Use PPM=0
- **Cheap blue dongles**: Typically need PPM 40-60 (varies per dongle)
- If DAB scan finds no stations, try PPM values from -100 to +100 in steps of 10
- Each dongle has its own specific PPM value due to manufacturing variance
- FM reception is more tolerant and usually works without PPM correction

**DAB Metadata (DLS)**:
The plugin automatically extracts now-playing information from DAB broadcasts:
- **DLS (Dynamic Label Segment)**: Text metadata broadcast by DAB stations
- **Artist/Title Parsing**: Automatically parses "Artist - Title" format
- **Artwork Integration**: Plugin fetches album artwork via Last.fm API

When playing a DAB station, you may see:
- Station name in the title field
- Artist name from DLS
- Track title from DLS
- Album artwork fetched via Last.fm

Note: Not all stations broadcast DLS metadata, and formats vary by broadcaster.

**Technical Service Names**:
DAB stations use technical identifiers that may differ from display names:
- Example: Enter "BBC Radio1" (no space) for the station branded as "BBC Radio 1" (with space)
- These are broadcast identifiers from the DAB ensemble
- Must match exactly as transmitted

**Default Test Values (UK/London)**:
- FM: 94.9 MHz (BBC Radio London)
- DAB Ensemble: 12B
- DAB Service: BBC Radio1
- Test Gain: 20 (NESDR Smart)

### Web Interface Access
The station management interface is accessible through the plugin settings:
- Navigate to: Settings > Plugins > Installed Plugins > FM/DAB Radio
- Click "Open in New Tab" or "Open in Current Window"
- Direct access: `http://<volumio-ip>:3456`

## Installation

1. Install plugin through Volumio plugin store
2. Connect RTL-SDR USB dongle
3. Enable plugin in Volumio settings
4. Scan for available stations
5. Browse and play stations from "FM/DAB Radio" source

## Usage

### Plugin Settings Organization (v1.0.0+)
The plugin settings are organized for quick access:
1. **Radio Station Management** - First section, open by default with immediate access to station manager
2. **Radio Station Management Configuration** - Advanced settings (hostname override)
3. **FM Radio** - FM configuration (expand to see settings)
4. **DAB/DAB+ Radio** - DAB configuration (expand to see settings)
5. **Diagnostics** - Testing tools for your USB dongle

### Playing Stations
1. Navigate to "Music Library" in Volumio
2. Select "FM/DAB Radio" source
3. Browse available stations
4. Click to play

### Managing Stations
1. Open plugin settings: Settings > Plugins > Installed Plugins > FM/DAB Radio
2. Click "Open in New Tab" or "Open in Current Window" in the Station Management section
3. Use the web interface to:
   - Mark favorites (star icon)
   - Hide stations (eye icon)
   - Delete stations (trash icon)
   - Rename stations (edit name field)
   - Search for stations
   - Rescan for new stations

### Testing Your Dongle
1. Open plugin settings
2. Expand "Diagnostics" section (if collapsed)
3. Enable "Show Diagnostics"
3. Enter test values (defaults provided for UK/London)
4. Click "Save Test Settings"
5. Click test button (FM or DAB)
6. Adjust gain if needed based on audio quality

### Save Options
Three ways to save changes:
- Click green save button on individual changed rows
- Click "Save (n)" button at top (saves all changes)
- Use save bar at bottom (saves all changes)

## Development

Prototype repository: https://github.com/foonerd/volumio-plugins-sources-bookworm
Target repository: https://github.com/volumio/volumio-plugins-sources-bookworm

## Architecture

- Plays through Volumio's own audio output, so volume, DSP and multiroom apply
- Minimal CPU overhead (suitable for Pi Zero W2)
- Direct PCM passthrough for FM (no encoding/decoding)
- Sox resampling for DAB (handles variable sample rates: 32kHz, 48kHz)
- Integrated with Volumio's music_service framework
- Web management interface on port 3456
- Station data stored in JSON format
- DAB decoding via dab-cmdline (https://github.com/JvanKatwijk/dab-cmdline/tree/master/example-3)

## Troubleshooting

### Plugin won't enable
- Check RTL-SDR dongle is connected
- Verify dongle is detected: `lsusb | grep RTL`

### No stations found
- Check antenna is connected
- Try adjusting scan sensitivity in settings
- Look at the player's log after a scan: it names the gain of every slice of the band and the reception of every station found
- Ensure good signal reception (location dependent)
- Use diagnostics tools to test reception first

### Test buttons require save
- Test buttons read saved configuration values, not current inputs
- Always click "Save" before testing
- This ensures consistent test conditions

### Web interface not accessible
- Verify port 3456 is not blocked by firewall
- Check plugin is enabled
- Try accessing via hostname: `http://volumio.local:3456`

## License

GPL-3.0

## Author

Just a Nerd

## Credits

- Wheaten - SNR measurement algorithm (snrd-api_V2.sh), adapted for gain optimizer tool

## Version History

### v1.3.24 (Current)
- A stations backup carries the logos you chose for stations yourself, and a restore
  puts them back: from the backup history, from an uploaded backup, or when the plugin
  takes its station list from a backup at start. Before, a restore on another player or
  a fresh card brought the stations back without them
- The backup type "Stations Only" is named "Stations (with your own logos)"
- Backups made by earlier versions restore as before

### v1.3.23
- With an artwork timeout set, a new song after a long one still showed the station's
  logo before its cover, and the cool-off of v1.3.22 kept the logo there for its two
  seconds. A cover whose time is up now stays while the next song is looked up and
  gives way to that song's cover; with nothing to take its place it leaves the screen
  as before

### v1.3.22
- Artwork no longer flickers when a station repeats a song's name. A song named again
  changes nothing; a new song keeps the picture on the screen until its own cover is
  found. Before, every such text showed the station's logo for a moment and then the
  cover again
- A line read as artist and title that no music database knows (a presenter's line)
  keeps the picture, as a slogan does. A real song without a cover still shows the
  station's logo
- New setting "Artwork Cool-off" (Settings > Artwork), 2 seconds unless set otherwise:
  the shortest time a picture stays before another replaces it. The text is never held
  back
- A lookup that fails for want of a network is made again with the next text, instead
  of being remembered as "no cover" until the plugin restarts
- The same on FM and DAB

### v1.3.21
- A logo of your own for any station, set in the Station Manager: a picture of yours
  (PNG, JPEG or SVG), one of the broadcasters' logos found by a search, or one already
  on the player. It stands above the logo found for the station, and "Back to
  automatic" returns to that
- The upload states what a picture should be, shows it as it will look, fits one that
  is not square, scales a large one down, and says in plain words why a file cannot be
  used
- Every station row shows its logo. A "No logo" card counts the stations without one
  and, pressed, shows only those
- The logo count under Maintenance said "DAB stations" while counting FM stations too

### v1.3.20
- FM stations are shown with their logo. A station is found by its RDS programme code
  once that has been received while it plays, and until then by its name: among your
  DAB stations that have a logo, then in the broadcasters' lists
- What RDS says of a station is kept with it: the programme code, and the name once it
  has stood unchanged for half a minute. A station still called "FM 98.5" takes the
  name its broadcaster's list or RDS gives it; a name you gave it is never changed
- An FM scan listens briefly to the stations strong enough for RDS and keeps their
  programme codes, so that such stations are named and shown with their logo straight
  after the scan
- A rescan removes FM stations that an earlier scan listed, that it looked for and did
  not find, and that were never named, marked or played. Everything you have touched
  stays
- The Station Manager's logo count includes FM stations

### v1.3.19
- The check for an overloaded tuner compares the band with how it looks at a gain
  20 dB lower and takes the highest gain at which it looks the same. v1.3.18 compared
  with a gain only 6 dB lower, and a tuner deep in overload looked the same at both:
  on the test player the gain next to a very strong station was not taken down, and
  two signals made in the tuner were listed as stations
- A carrier more than 15 kHz off its channel is not taken for a station

### v1.3.18
- The FM scan finds stations, not signal strength. Every channel of the band is
  measured and kept only if it carries the pilot of a stereo broadcast, stands above
  the channels next to it, and keeps its pilot when the gain is lowered. The channels
  beside a strong station and signals a tuner makes when it is overloaded are no
  longer listed as stations
- Each station found gets a reception level from 1 to 5
- The scan takes the band in slices, each at its own measured gain, and measures
  every channel itself. The spectrum tool the earlier scan relied on, run with the
  tuner's automatic gain, returned no reading for more than half of the band on the
  test player, stations included
- FM gain: the tuner is checked for overload, not only the converter. Near a very
  strong station the gain is taken down until the tuner treats all signals alike;
  measured on an RTL-SDR Blog V4 next to such a station, its neighbours gained 6 to
  8 dB of reception and two signals that were not on the air disappeared
- FM Scan Sensitivity is now how far a station's pilot must stand above the noise
- The Station Manager shows how far a scan has come
- Gains measured by v1.3.17 are measured again

### v1.3.17
- FM gain is measured instead of guessed. The first time a station is played, the gain
  is set to the highest step at which its signal does not overload the receiver, and
  kept with the station; after a week it is measured again. The first play of a station
  takes a second or two longer for it
- New setting "Automatic FM gain" (Settings > FM), on by default. Switched off, the
  gain set by hand is used as before
- If the gain cannot be measured, the station plays at the gain set by hand

### v1.3.16
- DAB gain is measured instead of guessed. Every time a station is tuned, and at every
  channel of a scan, the decoder sets the gain to the highest step at which the signal
  does not overload the receiver. A gain set too low leaves a DAB signal in the noise
  of the receiver itself: audio may still play while text arrives damaged, pictures do
  not arrive, and weak ensembles are not found
- New setting "Automatic DAB gain" (Settings > DAB), on by default. Switched off, the
  gain step set by hand is used as before
- The tuner's own automatic gain is not used: measured on an RTL-SDR Blog V4 it
  overloads the receiver until an ensemble cannot be read

### v1.3.15
- DAB text is put together only from pieces that arrive intact. On a weak signal a text
  used to appear with letters missing or with two texts run together; it now appears
  whole, a little later, or not at all
- The artist and title a DAB station marks in its text (DL Plus) are read as the
  standard lays them out
- The pictures a DAB station sends with its programme (slideshow) are shown on the
  player screen: the newest one, as it arrives, before any artwork that is looked up

### v1.3.14
- Station logos and the plugin's own icons no longer turn into the player's default
  picture on a screen after a plugin update. Volumio lets a screen keep what an artwork
  address gave it for a month, its default picture included, which is what it gives
  while an update has the plugin's folder away. The addresses the plugin hands out now
  change with every installation and with every replaced picture, so a screen asks again
- The installer makes the link to the station logos before anything else

### v1.3.13
- DAB signal level: classic DAB (MP2) stations no longer stay at one dot whatever the
  reception. Their level is judged by their own audio frames, as that of DAB+ stations
  is by theirs
- "Auto-backup before uninstall" does what it says: with it selected, uninstalling the
  plugin writes a dated backup of the station list, the block list and the settings,
  and keeps the station logos
- The node modules a plugin store install fetches are held to the versions the plugin
  is tested with

### v1.3.12
- The version submitted to the Volumio plugin store. No functional change from 1.3.10;
  everything new since 1.3.9 is listed under v1.3.10 below
- **Updating from 1.3.9 or earlier: create a backup in the Station Manager
  (Maintenance) first.** The update removes the old plugin folder, where 1.3.9 kept the
  station list; this version then restores the newest backup by itself

### v1.3.11
- No functional change. Published to try the plugin's own update path (Station Manager >
  Maintenance > Plugin Update) from one version to the next.

### v1.3.10
- The station list and the artwork block list survive plugin updates
  - They are kept with the plugin's settings instead of in the plugin's own folder,
    which Volumio replaces on every update
  - A list from an earlier version is moved over at the first start
  - A missing or unreadable list is restored from the newest backup
  - **Updating from 1.3.9 or earlier: create a backup in the Station Manager
    (Maintenance) first.** The update itself still removes the old folder; 1.3.10
    then restores the newest backup by itself
- Saving the station list can no longer fail silently or leave half a file behind
- Reliable switching and stopping
  - One part of the plugin owns the tuner: playback, scans and the antenna tools take
    turns, and each starts only when the one before has let the dongle go
  - Stopping ends the plugin's own processes and nothing else on the player
  - Rapid station changes end with the last station playing, once
  - A decoder that stops (dongle unplugged, DAB service not found) stops playback and
    says so, instead of showing "playing" in silence
- Station names with quotes or other special characters play correctly
- SNR measurement: a gain step of 0 no longer makes the player unresponsive
- Restoring an uploaded block list no longer overwrites the settings; restored settings
  take effect at once
- Binaries rebuilt
  - Raspberry Pi (arm): built for ARMv6, so they start on every Pi
  - x86-64: the RDS decoder no longer requires a processor with AVX2
- Installer: no sudoers entry, no loopback module, no removal of unrelated packages
- Station logos for DAB
  - Fetched from the broadcasters through RadioDNS, shown in the station lists and on
    the player screen
  - A station without a logo of its own is shown with its broadcaster's
  - Fetched in the background and only when there is an internet connection; kept
    across plugin updates
  - Station Manager > Maintenance > Station Logos shows the state and refreshes on demand
- FM tune level measured from the reception itself (the stereo pilot against the noise
  above it) instead of derived from RDS
- Artwork that changes while a station plays (a logo, the picture found for a song)
  is shown on the player screen
- Plugin update from the Station Manager, with a choice of channel: Stable and Beta
  from the Volumio plugin store, Preview from the project's pre-releases on GitHub;
  a test channel applies only on a player in Volumio's Plugins Test Mode; the version
  before an update can be put back
- New setting: the update channel (Station Manager > Maintenance > Plugin Update)

### v1.3.9
- New FM Scan Offset setting to align scan frequency grid with country channel plans
  - Configurable in FM Region section: 0 kHz (default), 50 kHz, or 100 kHz
  - Fixes station detection in countries where FM channels are at odd frequencies
    (e.g. Taiwan 88.1, 88.3, 88.5 instead of 88.0, 88.2, 88.4)
  - Set to 100 kHz for Taiwan, South Korea, and other countries with odd-tenth channels
- Fixed scan command using stale config value instead of region preset band start
- Fixed frequency rounding to align with effective scan grid (was rounding to multiples from zero)
- Fixed frequency validation in playback, diagnostics, and CSV import to use region band start
- Translated FM Scan Offset across all 11 languages

### v1.3.8
- FM Regional Standards support with automatic configuration
- New FM Region setting with 8 presets:
  - Europe (87.5-108 MHz, 100kHz spacing, 50us de-emphasis)
  - Americas (88-108 MHz, 200kHz spacing, 75us de-emphasis)
  - Japan (76-95 MHz, 100kHz spacing, 50us de-emphasis)
  - East Asia/Taiwan/Korea (88-108 MHz, 200kHz spacing, 50us de-emphasis)
  - Australia/Oceania (87.5-108 MHz, 200kHz spacing, 50us de-emphasis)
  - Italy (87-108 MHz, 50kHz spacing, 50us de-emphasis)
  - OIRT/Russia Legacy (65.8-74 MHz, 30kHz spacing, 50us de-emphasis)
  - Custom (manual override for all parameters)
- Scan now uses correct channel spacing per region (was hardcoded 125kHz)
- Station frequencies now round to correct channel grid
- Added FM Upper Frequency setting for regions with different band limits
- Added FM Channel Spacing setting for custom configurations
- De-emphasis now automatically applied based on region (except Custom mode)
- region.json data file for easy maintenance and future expansion

### v1.3.7
- Added 300 kHz sample rate option (2,400,000 S/s - matches SDR# default)
- Corrected FM settings guidance based on community testing
- IMPORTANT: Oversampling should only be used with 171kHz sample rate
  - Higher sample rates + oversampling causes noise or audio artifacts
- Updated documentation with S/s mapping for each sample rate
- Settings guidance based on community testing:
  - Europe/UK (weak signals): 171k, oversampling off, de-emphasis off
  - Europe/UK (noisy at 171k): 171k, oversampling ON, de-emphasis off
  - Strong signal regions (Asia, urban): 300k, oversampling OFF, de-emphasis on
  - Best audio quality: 300k, oversampling OFF, de-emphasis on

### v1.3.6
- FM Oversampling option to reduce audio distortion
  - Enable 4x oversampling for 171kHz sample rate only
  - WARNING: Do NOT combine with higher sample rates (causes noise/artifacts)
  - Default: Off
- FM Sample Rate selection
  - 171 kHz: Optimal for RDS decoding (default, Europe/UK)
  - 200 kHz: Better audio, reduced RDS (1,600,000 S/s)
  - 240 kHz: Good audio quality (1,920,000 S/s)
- FM De-emphasis filter
  - Applies 50us de-emphasis to reduce high-frequency harshness
  - Standard for FM broadcast in Europe, Asia, and Australia
  - Default: Off
- All settings in FM Radio configuration section

### v1.3.5
- Complete SNR Measurement Tool implementation
  - Fixed NaN handling for single channel measurements
  - Added guidance text explaining how to apply recommended gain value
  - Added note for RTL-SDR Blog V4 (R828D) users to extend range to 70
  - Updated default gain range to 0-50 (standard dongles max ~49.6 dB)
  - Full internationalization for all 11 languages
- Gain range maximum extended to 100 for V4/extended hardware testing

### v1.3.4
- SNR Measurement Tool (Tool 3) in Antenna Positioning tab
  - Based on snrd-api_V2.sh by Wheaten
  - Measures Signal-to-Noise Ratio across gain settings
  - Auto-detects channels from scanned stations or validation results
  - Recommends optimal gain for best signal quality
  - Configurable gain range and step size
- Fixed blocklist backup restore validation (regression from v1.3.3)

### v1.3.3
- CSV import/export for offline station editing
- Download FM and DAB station templates
- Export existing stations to CSV with timestamps
- Import with four operations:
  - Replace: Clear all stations and import fresh
  - Amend: Update existing stations, preserve play history
  - Extend: Add new stations only, skip duplicates
  - Remove: Mark matching stations as deleted
- Validation before import with detailed error reporting
- Respects regional FM frequency settings (Japan 76MHz, Italy 87MHz, etc.)

### v1.3.2
- Configurable FM lower frequency for regional band support
- Japan: 76.0 MHz lower bound (76-95 MHz band)
- Italy: 87.0 MHz lower bound (RAI Radio 1 at 87.1 MHz)
- Europe: 87.5 MHz (default)
- Americas: 88.0 MHz
- Setting in FM Radio configuration section
- FM scan automatically uses configured range

### v1.3.1
- Classical music artwork via Open Opus API fallback
- When Last.fm has no artwork for classical composers, displays composer portrait
- Recognizes 150+ classical composers (Bach, Beethoven, Mozart, etc.)
- Free API, no registration required, public domain portraits

### v1.3.0
- Fixed FM artwork throttle bug - metadata parsing now happens before throttle check
- Debug logging for artwork system now controlled by artwork_debug_logging setting
- Includes all v1.2.9 fixes: blocklist check, signal suffix strip, soundtrack pattern, prefix patterns

### v1.2.9
- Fixed Signal suffix in DLS breaking metadata parser
- Added soundtrack pattern for Classic FM format (Album - Track by Artist)
- Added alternative pattern (Track by Artist from Album)

### v1.2.8
- Best Effort Artwork: Album artwork via Last.fm API with intelligent metadata parsing
- Configurable confidence threshold (0-95%) controls when lookups are triggered
- Artwork persistence prevents flicker during metadata gaps
- Artwork timeout for spoken word content (auto-revert to station icon)
- Artwork Block List in Station Manager to filter false matches
- Fuzzy matching tolerates RDS/DAB text corruption (75% similarity threshold)
- Time and date announcements filtered automatically
- Blocklist has dedicated backup/restore (separate from stations)
- Debug logging toggle for artwork troubleshooting
- Fixed: FM Recently Played not updating for stations with edited frequencies
- Fixed: Auto-repairs stations where frequency was saved as number instead of string
- 11-language translations for all new features

### v1.2.6
- Fixed signal quality indicator not updating in Volumio playback screen
- Signal level changes now bypass 2-second throttle for responsive UI
- Fixed custom station names not displaying on playback start
- Custom names now looked up from database at playback time (FM and DAB)
- Fixed frequency comparison using parseFloat for reliable matching
- Fixed hidden stations still showing in Volumio media sources
- Hidden stations now properly filtered from FM, DAB, and ensemble browse views

### v1.2.5
- Added real-time signal quality indicator for FM and DAB
- Signal strength displayed in Volumio playback screen (5-level indicator)
- Signal quality shown in station manager for currently playing station
- Color-coded Font Awesome signal icon (red/orange/yellow/green based on level)
- Currently playing station highlighted with green border in station manager
- FM signal quality derived from RDS block error rate (BLER)
- DAB signal quality derived from FIB quality and AAC decode success rate
- Updated fn-dab binaries with signal quality callbacks

### v1.2.2
- Added DAB DLS metadata extraction (artist/title from broadcast)
- Volumio now fetches album artwork via MusicBrainz for DAB stations
- Improved state management for DAB playback with customName priority
- DLS text parsed for common formats: "Artist - Title", "Title by Artist"

### v1.2.1
- Added PPM (frequency correction) setting for DAB reception
- Resolves DAB reception issues with cheap RTL-SDR dongles that have inaccurate crystal oscillators
- Quality dongles (Nooelec NESDR, RTL-SDR Blog V3/V4) work at PPM=0
- Cheap generic blue dongles typically need PPM 40-60
- PPM setting available in both DAB Radio section and Diagnostics for testing
- DAB channel validation now uses configured gain (was hardcoded to 80)
- Added tuner type detection and logging in fn-dab binaries
- Fixed bug in rtlsdr-handler checking wrong variable for V4 dongle support
- Added missing TRAFFIC_ALERT translations for 10 languages

### v1.2.0
- Major rewrite of DAB audio pipeline with dynamic sample rate detection
- Automatic PCM format detection from fn-dab stderr output
- Sox-based resampling handles 32kHz/48kHz DAB streams transparently
- Consolidated timeout constants for easier maintenance
- Fixed race conditions in station switching
- 600ms hardware cleanup delay prevents device conflicts
- RDS metadata display for FM stations via fn-redsea
- Complete 11-language internationalization

### v1.0.9
- Added Antenna Positioning Tools
- RF Spectrum Scan: Full-band signal visualization (87.5-240 MHz, 2-second scan)
- DAB Channel Validation: Progressive SSE streaming, per-channel sync and service count
- Fixed three critical DAB scanner bugs:
  - Service count detection (PTY wrapper filtering for PCM-only output)
  - Completion timeout (immediate scanner kill on completion marker)
  - No-signal channel overshoot (immediate kill on channel switch detection)
- Typical validation times: 10-15s with signal, 2-3s no signal (no 30s timeouts)
- Translation concept corrected across 11 languages: "positioning" (antenna orientation for signal) not "alignment" (physical leveling)
- Complete antenna positioning tab translation coverage (49 UI elements)
- All 11 language files validated: 366 keys each, no duplicates, valid JSON
- Comprehensive DAB channel validation workflow guidance

### v1.0.7
- Added comprehensive backup and restore system
- Three backup types: Stations Only, Configuration Only, Full Backup
- Automatic backup pruning (keeps 5 most recent per type)
- ZIP export/import functionality
- Upload and validate external backups with preview
- Mix-and-match restore capability
- Optional auto-backup before plugin uninstall
- Backup history table with download/delete actions
- Fully internationalized (11 languages)

### v1.0.6
- Added sox resampling pipeline for DAB playback with automatic PCM format detection
- Handles variable DAB sample rates (32kHz, 48kHz) transparently
- Added EPIPE error handling for robust process pipeline management
- Fixed station switching regression

### v1.0.0
- Production release - beta testing complete
- Eliminated restart requirement after installation
- Streamlined install process removes obsolete reboot warnings
- DVB-T kernel module management fully automated during install
- Ready for public release

### v0.9.8
- UI reorganization: Station manager now appears first in plugin settings
- Station manager section open by default for immediate access
- FM/DAB configuration sections collapsed by default for cleaner presentation
- Clearer toggle labels: "Show" instead of "Enable"
- Simplified installation (no Volumio core file modification)
- Two access methods for station manager (via plugin settings)

#### Language support
- Full multilingual support: 11 languages fully translated
- Plugin settings UI now uses Volumio's standard translation system
- Web manager automatically detects Volumio's language setting via API
- Both plugin settings and web interface respect user's language choice
- No manual configuration required for language selection

### v0.9.7
- Clarified test button requirements with clear warning messages
- Improved default values (UK/London optimized)
- Enhanced documentation for technical service names vs display names
- Added comprehensive RF gain explanation
- Better diagnostics guidance for troubleshooting

### v0.9.6
- Fixed message element rendering in UI
- Changed from 'message' to 'section' elements with 'description' field

### v0.9.2
- Defense-in-depth save strategy
- Per-row save buttons
- Improved user feedback
- CSS specificity fixes
