![VolumeHub](docs/assets/volumehub-marquee.png)

# VolumeHub

Boost any tab up to 600%, fine-tune sound with a 3-band EQ, and let VolumeHub remember your settings for every site.

## Features

**Volume**
- Boost any tab up to 600% volume
- Auto-saves your level for every site
- See and mute tabs playing audio in real time
- Live audio visualizer

**EQ**
- 3-band equalizer: bass, mid, and treble
- ±12 dB range per band
- One-click presets: Flat, Bass Boost, Vocal, Night Mode

**Settings**
- Dark and light mode
- Set a default volume for new sites
- Auto-apply saved levels when you open the popup
- Auto-mute every new tab as it opens
- View, remove, or bulk-delete sites with saved settings
- Export and import all settings as a backup

**Keyboard shortcut**
- Mute or unmute the active tab instantly with a keyboard shortcut
- Chrome does not guarantee suggested shortcuts are applied automatically. Set yours at `chrome://extensions/shortcuts`

## Installation

### Chrome Web Store

[Install VolumeHub from the Chrome Web Store](https://chromewebstore.google.com/detail/volumehub/jdojcahmkfkdameooeogkcgjapofjlgi)

### From source

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

## Notes

**Fullscreen on streaming sites:** Some streaming services (Amazon Prime Video, Disney+, Peacock) block the in-player fullscreen button when a browser extension is controlling audio. This is a browser-level restriction, not a bug. Pressing F11 works normally as an alternative.

**Auto-mute new tabs:** When enabled in Settings, every new tab is silenced the moment it opens. Individual tabs can be unmuted anytime from the popup's audio tabs list.

## Privacy

VolumeHub stores all settings locally on your device using `chrome.storage.local`. No data is collected, transmitted, or shared. See the full [privacy policy](https://voiceofgrog.github.io/volumehub/docs/privacy.html).

## License

MIT — see [LICENSE](LICENSE)
