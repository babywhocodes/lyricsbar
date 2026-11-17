import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { LyricsClient } from './lyricsClient.js';

const SPOTIFY_BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Helper function to format duration in microseconds to mm:ss with time units (e.g. 5m 00s or 1h 05m 20s)
function formatDuration(microseconds) {
    if (typeof microseconds === 'bigint') {
        microseconds = Number(microseconds);
    }
    if (!microseconds || isNaN(microseconds) || microseconds <= 0) {
        return null;
    }
    const totalSeconds = Math.round(microseconds / 1000000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const paddedSeconds = seconds.toString().padStart(2, '0');
    if (hours > 0) {
        const paddedMinutes = minutes.toString().padStart(2, '0');
        return `${hours}h ${paddedMinutes}m ${paddedSeconds}s`;
    }
    return `${minutes}m ${paddedSeconds}s`;
}


// Read seek cursor position from /proc/<pid>/fdinfo/<fd>
function getFdPos(pid, fd) {
    try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/fdinfo/${fd}`);
        if (!ok) return 0;
        const text = new TextDecoder('utf-8').decode(contents);
        const m = text.match(/^pos:\s*(\d+)/m);
        return m ? parseInt(m[1], 10) : 0;
    } catch (e) {
        return 0;
    }
}

// Find all Spotify PIDs for the current user
function findSpotifyPids() {
    try {
        const username = GLib.get_user_name();
        let [res, out, err, status] = GLib.spawn_command_line_sync(`pgrep -u ${username} -x spotify`);
        if (!res || status !== 0 || !out || out.length === 0) {
            [res, out, err, status] = GLib.spawn_command_line_sync(`pgrep -u ${username} -f usr/share/spotify/spotify`);
        }
        if (!res || status !== 0 || !out) return [];
        const text = new TextDecoder('utf-8').decode(out);
        return text.trim().split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p));
    } catch (e) {
        return [];
    }
}

// Find open Spotify audio stream cache file in /proc/<pid>/fd/
function findActiveAudioCache(pids) {
    const candidates = [];
    for (const pid of pids) {
        const fdDir = `/proc/${pid}/fd`;
        try {
            const dir = Gio.File.new_for_path(fdDir);
            const enumerator = dir.enumerate_children(
                'standard::*',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const linkTarget = GLib.file_read_link(`${fdDir}/${name}`);
                if (linkTarget && linkTarget.endsWith('.file') && linkTarget.includes('/Data/')) {
                    try {
                        const file = Gio.File.new_for_path(linkTarget);
                        const qInfo = file.query_info(
                            'standard::size,time::modified',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );
                        const pos = getFdPos(pid, name);
                        candidates.push({
                            pid: pid,
                            fd: name,
                            path: linkTarget,
                            logicalSize: qInfo.get_size(),
                            pos: pos,
                            mtime: qInfo.get_attribute_uint64('time::modified')
                        });
                    } catch (err) {}
                }
            }
        } catch (e) {}
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (b.pos !== a.pos) return b.pos - a.pos;
        return b.mtime - a.mtime;
    });
    return candidates[0];
}

const MusicLyricsIndicator = GObject.registerClass(
    class MusicLyricsIndicator extends PanelMenu.Button {
        _init(settings) {
            super._init(0.5, 'Music Lyrics Indicator');

            this._settings = settings;

            // Create a box to hold label and info icon
            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box'
            });

            this._label = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label'
            });

            // Enable text clipping with ellipsis
            this._label.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END

            // Info icon button
            this._infoIcon = new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'system-status-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
                reactive: true
            });

            box.add_child(this._label);
            box.add_child(this._infoIcon);
            this.add_child(box);

            // Show/hide info icon on hover
            this.connect('enter-event', () => {
                this._infoIcon.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                // Update truncation on hover just in case
                this._updateLabelText();
            });

            this.connect('leave-event', () => {
                this._infoIcon.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            });

            this._currentTrack = null;
            this._lyricsClient = new LyricsClient();
            this._currentLyrics = null;
            this._currentLine = '';
            this._currentTrackDuration = null;
            this._proxy = null;
            this._playerProxy = null;
            this._propertiesChangedId = null;
            this._lyricsTimeoutId = null;
            this._busConnection = null;
            this._busSignalId = null;
            this._playerBusName = null;
            this._playerRunning = false;
            this._spotifyRunning = false;
            this._verifiedQuality = null;
            this._qualitySampleTimeoutId = null;
            this._qualityPollTimeoutId = null;
            this._spotifyPids = [];
            this._lastTrackKey = null;
            this._isShowingTrackTitle = false;
            this._lyricsRetryTimeoutId = null;
            this._lyricsRetryIndex = 0;
            this._lyricsRetryStartTime = 0;

            // Internal state for lyrics - using GSettings for preferences now
            this._showLyrics = true;

            // Connect setting signals
            this._settingsSignalId = this._settings.connect('changed::max-text-length', () => {
                this._updateLabelText();
            });

            this._buildMenu();
            this.updateVisibility();
            this._setupDBusMonitoring();
        }

        _buildMenu() {
            // Player info section
            this._playerInfoItem = new PopupMenu.PopupMenuItem('No player connected', {
                reactive: false
            });
            this._playerInfoItem.label.style = 'font-size: 0.85em; color: #888;';
            this.menu.addMenuItem(this._playerInfoItem);

            // Track info section
            this._trackInfoItem = new PopupMenu.PopupMenuItem('No track playing', {
                reactive: false
            });
            this.menu.addMenuItem(this._trackInfoItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Playback controls
            const controlsBox = new St.BoxLayout({
                style_class: 'popup-menu-item',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                style: 'spacing: 12px;'
            });

            const prevButton = new St.Button({
                style_class: 'button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                child: new St.Icon({
                    icon_name: 'media-skip-backward-symbolic',
                    icon_size: 20
                })
            });
            prevButton.connect('clicked', () => this._controlPlayback('Previous'));

            const playPauseButton = new St.Button({
                style_class: 'button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                child: new St.Icon({
                    icon_name: 'media-playback-start-symbolic',
                    icon_size: 20
                })
            });
            this._playPauseButton = playPauseButton;
            playPauseButton.connect('clicked', () => this._controlPlayback('PlayPause'));

            const nextButton = new St.Button({
                style_class: 'button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                child: new St.Icon({
                    icon_name: 'media-skip-forward-symbolic',
                    icon_size: 20
                })
            });
            nextButton.connect('clicked', () => this._controlPlayback('Next'));

            controlsBox.add_child(prevButton);
            controlsBox.add_child(playPauseButton);
            controlsBox.add_child(nextButton);

            const controlsItem = new PopupMenu.PopupBaseMenuItem({
                reactive: true,
                activate: false,
                hover: false,
                can_focus: false
            });
            controlsItem.add_child(controlsBox);
            this.menu.addMenuItem(controlsItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Toggle lyrics display
            this._lyricsToggle = new PopupMenu.PopupSwitchMenuItem(
                'Show Lyrics',
                this._showLyrics
            );
            this._lyricsToggle.connect('toggled', (item) => {
                this._showLyrics = item.state;
                if (!item.state) {
                    this._clearLyricsRetry();
                    if (this._lyricsTimeoutId) {
                        GLib.source_remove(this._lyricsTimeoutId);
                        this._lyricsTimeoutId = null;
                    }
                    this._currentLyrics = null;
                    this._isShowingTrackTitle = false;
                    if (this._currentTrack) {
                        this._updateLabelText(this._currentTrack.title, false);
                    }
                } else {
                    if (this._currentTrack) {
                        this._isShowingTrackTitle = true;
                        this._fetchLyrics(this._currentTrack.title, this._currentTrackDurationSeconds);
                    }
                }
            });
            this.menu.addMenuItem(this._lyricsToggle);

            const refreshLyricsItem = new PopupMenu.PopupMenuItem('Refresh Lyrics');
            refreshLyricsItem.connect('activate', () => this._refreshLyrics());
            this.menu.addMenuItem(refreshLyricsItem);

            // Song duration and audio quality display
            this._durationItem = new PopupMenu.PopupMenuItem('--:--', {
                reactive: false
            });
            this._durationItem.label.style = 'font-size: 0.9em; color: #888;';
            this.menu.addMenuItem(this._durationItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Refresh button
            const refreshItem = new PopupMenu.PopupMenuItem('Refresh Player');
            refreshItem.connect('activate', () => {
                this._refreshPlayerConnection();
            });
            this.menu.addMenuItem(refreshItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Info submenu
            this._infoSubmenu = new PopupMenu.PopupSubMenuMenuItem('About');

            // GitHub link
            const githubItem = new PopupMenu.PopupMenuItem('View on GitHub');
            githubItem.connect('activate', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(
                        'https://github.com/babywhocodes/lyricsbar',
                        global.create_app_launch_context(0, -1)
                    );
                } catch (e) {
                    logError(e, 'Failed to open GitHub link');
                }
            });
            this._infoSubmenu.menu.addMenuItem(githubItem);

            // Credits
            const creditsItem = new PopupMenu.PopupMenuItem('Created by babywhocodes', {
                reactive: false
            });
            creditsItem.label.style = 'font-size: 0.9em; color: #888;';
            this._infoSubmenu.menu.addMenuItem(creditsItem);

            this.menu.addMenuItem(this._infoSubmenu);
        }

        _controlPlayback(action) {
            if (!this._playerProxy) {
                return;
            }

            try {
                this._playerProxy.call(
                    action,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            proxy.call_finish(result);
                        } catch (e) {
                            logError(e, `Failed to finish ${action}`);
                        }
                    }
                );
            } catch (e) {
                logError(e, `Failed to ${action}`);
            }
        }

        _updatePlayPauseButton() {
            if (!this._playerProxy || !this._playPauseButton) {
                return;
            }

            try {
                const playbackStatus = this._playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    const icon = status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                    this._playPauseButton.child.icon_name = icon;
                }
            } catch (e) {
                logError(e, 'Failed to update play/pause button');
            }
        }

        updateVisibility() {
            const visible = Boolean(this._playerRunning);
            this.visible = visible;
            if (this.container) {
                this.container.visible = visible;
            }
        }

        _resetQualityVerification() {
            if (this._qualitySampleTimeoutId) {
                GLib.source_remove(this._qualitySampleTimeoutId);
                this._qualitySampleTimeoutId = null;
            }
            if (this._qualityPollTimeoutId) {
                GLib.source_remove(this._qualityPollTimeoutId);
                this._qualityPollTimeoutId = null;
            }
            this._verifiedQuality = null;
        }

        _startQualityVerification() {
            if (!this._spotifyRunning || !this._currentTrack) {
                return;
            }

            if (!this._spotifyPids || this._spotifyPids.length === 0) {
                this._spotifyPids = findSpotifyPids();
            }

            if (!this._spotifyPids || this._spotifyPids.length === 0) {
                this._updateDurationDisplay();
                return;
            }

            const active = findActiveAudioCache(this._spotifyPids);
            if (!active) {
                // If audio file is not opened yet, retry in 1 second
                this._qualitySampleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._qualitySampleTimeoutId = null;
                    this._startQualityVerification();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }

            const trackTitle = this._currentTrack.title;
            const initialSize = active.logicalSize;
            const filePath = active.path;
            const durationSeconds = this._currentTrackDurationSeconds || 0;

            // Sample file growth over 1.0 second window
            this._qualitySampleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._qualitySampleTimeoutId = null;

                // Make sure track didn't change while waiting
                if (!this._currentTrack || this._currentTrack.title !== trackTitle) {
                    return GLib.SOURCE_REMOVE;
                }

                let newSize = initialSize;
                try {
                    const file = Gio.File.new_for_path(filePath);
                    const qInfo = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                    newSize = qInfo.get_size();
                } catch (e) {
                    return GLib.SOURCE_REMOVE;
                }

                const deltaBytes = newSize - initialSize;
                if (deltaBytes > 0) {
                    // Download in progress / actively buffering
                    const mb = (newSize / (1024 * 1024)).toFixed(1);
                    this._verifiedQuality = {
                        buffering: true,
                        mb: mb,
                        fileSize: newSize
                    };
                    this._updateDurationDisplay();

                    // Re-sample in 1.0 second
                    this._qualitySampleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._qualitySampleTimeoutId = null;
                        this._startQualityVerification();
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                }

                // deltaBytes === 0: Complete and stable!
                const durS = durationSeconds > 0 ? durationSeconds : 1;
                const kbps = Math.round((newSize * 8) / durS / 1000);
                const mb = (newSize / (1024 * 1024)).toFixed(1);

                this._verifiedQuality = {
                    verified: true,
                    buffering: false,
                    calculated: `~${kbps}kbps (${mb}MB)`,
                    kbps: kbps,
                    mb: mb,
                    fileSize: newSize,
                    filePath: filePath,
                    pid: active.pid,
                    fd: active.fd
                };

                this._updateDurationDisplay();

                // Start 10-second polling for stream updates
                this._startQualityPolling(filePath, trackTitle);

                return GLib.SOURCE_REMOVE;
            });
        }

        _startQualityPolling(filePath, trackTitle) {
            if (this._qualityPollTimeoutId) {
                GLib.source_remove(this._qualityPollTimeoutId);
                this._qualityPollTimeoutId = null;
            }

            this._qualityPollTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                // If song changed or Spotify closed, stop polling
                if (!this._currentTrack || this._currentTrack.title !== trackTitle || !this._spotifyRunning) {
                    this._qualityPollTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    const file = Gio.File.new_for_path(filePath);
                    if (!file.query_exists(null)) {
                        this._qualityPollTimeoutId = null;
                        this._startQualityVerification();
                        return GLib.SOURCE_REMOVE;
                    }

                    const qInfo = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                    const currentSize = qInfo.get_size();
                    const prevSize = this._verifiedQuality ? this._verifiedQuality.fileSize : 0;

                    if (currentSize > prevSize) {
                        // File grew! Re-verify stability
                        this._qualityPollTimeoutId = null;
                        this._startQualityVerification();
                        return GLib.SOURCE_REMOVE;
                    } else if (this._verifiedQuality && this._verifiedQuality.verified) {
                        // Update display if needed
                        this._updateDurationDisplay();
                    }
                } catch (e) {
                    logError(e, 'Failed to poll Spotify audio file size');
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        _updateDurationDisplay() {
            if (!this._durationItem) {
                return;
            }

            const dur = this._currentTrackDuration || '--:--';
            const q = this._verifiedQuality;

            if (q && q.verified) {
                this._durationItem.label.text = `${dur} | ${q.calculated}`;
            } else if (q && q.buffering) {
                this._durationItem.label.text = `${dur} | Buffering (${q.mb}MB)`;
            } else if (this._currentTrackDuration) {
                this._durationItem.label.text = `${this._currentTrackDuration} | Quality: Unverified`;
            } else {
                this._durationItem.label.text = '--:--';
            }
        }

        _setupDBusMonitoring() {
            try {
                this._busConnection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
                this._busSignalId = this._busConnection.signal_subscribe(
                    'org.freedesktop.DBus',
                    'org.freedesktop.DBus',
                    'NameOwnerChanged',
                    '/org/freedesktop/DBus',
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_connection, _sender, _path, _interface, _signal, parameters) => {
                        const [name, oldOwner, newOwner] = parameters.deep_unpack();
                        if (!name.startsWith('org.mpris.MediaPlayer2.')) {
                            return;
                        }

                        if (name === this._playerBusName && oldOwner && !newOwner) {
                            this._disconnectSpotify();
                            this._connectToAvailablePlayer();
                        } else if (!this._playerRunning && newOwner) {
                            this._connectToPlayer(name);
                        }
                    }
                );
                this._connectToAvailablePlayer();
            } catch (e) {
                logError(e, 'Failed to monitor MPRIS players');
            }
        }

        _getMprisPlayerNames() {
            const reply = Gio.DBus.session.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            const [names] = reply.deep_unpack();
            return names.filter(name => name.startsWith('org.mpris.MediaPlayer2.'));
        }

        _connectToAvailablePlayer() {
            try {
                const names = this._getMprisPlayerNames();
                const player = names.includes(SPOTIFY_BUS_NAME)
                    ? SPOTIFY_BUS_NAME
                    : names[0];
                if (player) {
                    this._connectToPlayer(player);
                }
            } catch (e) {
                logError(e, 'Failed to find an MPRIS player');
            }
        }

        _refreshPlayerConnection() {
            if (this._playerBusName) {
                this._connectToPlayer(this._playerBusName);
            } else {
                this._connectToAvailablePlayer();
            }
        }

        _connectToPlayer(busName) {
            try {
                if (this._propertiesChangedId && this._playerProxy) {
                    this._playerProxy.disconnect(this._propertiesChangedId);
                    this._propertiesChangedId = null;
                }

                this._proxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    'org.freedesktop.DBus.Properties',
                    null
                );

                this._playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                this._propertiesChangedId = this._playerProxy.connect(
                    'g-properties-changed',
                    this._onPropertiesChanged.bind(this)
                );

                this._playerBusName = busName;
                this._playerRunning = true;
                this._spotifyRunning = busName === SPOTIFY_BUS_NAME;
                this.updateVisibility();
                this._updatePlayerInfo();
                this._updateTrackInfo();
                this._updatePlayPauseButton();
                return true;
            } catch (e) {
                logError(e, `Failed to connect to MPRIS player ${busName}`);
                return false;
            }
        }

        _disconnectSpotify() {
            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }

            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            this._clearLyricsRetry();

            this._proxy = null;
            this._playerProxy = null;
            this._playerBusName = null;
            this._playerRunning = false;
            this._spotifyRunning = false;
            this._currentTrack = null;
            this._currentLyrics = null;
            this._currentLine = '';
            this._currentTrackDuration = null;
            this._currentTrackDurationSeconds = null;
            this._lastTrackKey = null;
            this._isShowingTrackTitle = false;
            this._spotifyPids = [];
            this._resetQualityVerification();

            this._updateLabelText('');
            this.updateVisibility();
            this._updatePlayerInfo();
            if (this._trackInfoItem) {
                this._trackInfoItem.label.text = 'No track playing';
            }
            if (this._durationItem) {
                this._durationItem.label.text = '--:--';
            }
        }

        _updatePlayerInfo() {
            if (!this._playerProxy) {
                this._playerInfoItem.label.text = 'No player connected';
                return;
            }

            const playerName = this._playerBusName?.split('.').at(-1) || 'Player';
            this._playerInfoItem.label.text = `🎵 Playing from ${playerName}`;
        }

        _onPropertiesChanged() {
            this._updateTrackInfo();
            this._updatePlayPauseButton();
        }

        _updateTrackInfo() {
            if (!this._playerProxy) {
                return;
            }

            try {
                const metadata = this._playerProxy.get_cached_property('Metadata');
                if (!metadata) {
                    this._updateLabelText('');
                    this._trackInfoItem.label.text = 'No track playing';
                    this._currentTrackDuration = null;
                    if (this._durationItem) {
                        this._durationItem.label.text = '--:--';
                    }
                    return;
                }

                const metadataDict = metadata.deep_unpack();
                const title = metadataDict['xesam:title']?.unpack() || null;
                const artist = metadataDict['xesam:artist']?.deep_unpack()[0] || null;
                const album = metadataDict['xesam:album']?.unpack() || null;

                // If both title and artist are missing
                if (!title && !artist) {
                    this._updateLabelText('');
                    this._trackInfoItem.label.text = 'Unknown track';
                    this._currentTrackDuration = null;
                    if (this._durationItem) {
                        this._durationItem.label.text = '--:--';
                    }
                    return;
                }

                this._currentTrack = {
                    title: title || 'Unknown Track',
                    artist: artist || 'Unknown Artist',
                    album: album || 'Unknown Album'
                };

                // Update menu with track info
                this._trackInfoItem.label.text = `${this._currentTrack.artist} - ${this._currentTrack.title}`;

                // Extract track duration
                const lengthVariant = metadataDict['mpris:length'];
                let formattedDur = null;
                let durationSeconds = null;
                if (lengthVariant) {
                    const lengthUs = typeof lengthVariant.unpack === 'function'
                        ? lengthVariant.unpack()
                        : lengthVariant;
                    formattedDur = formatDuration(lengthUs);
                    if (lengthUs && !isNaN(Number(lengthUs))) {
                        durationSeconds = Math.round(Number(lengthUs) / 1000000);
                    }
                }
                this._currentTrackDuration = formattedDur;
                this._currentTrackDurationSeconds = durationSeconds;

                const trackKey = this._trackKey(this._currentTrack);
                const previousTrackKey = this._lastTrackKey || '';
                this._lastTrackKey = trackKey;

                if (previousTrackKey !== trackKey) {
                    this._resetQualityVerification();
                    this._startQualityVerification();

                    this._clearLyricsRetry();

                    // Immediately display the new track title on the panel
                    this._isShowingTrackTitle = true;
                    this._currentLine = '';
                    this._updateLabelText(this._currentTrack.title, false);

                    // Try to fetch lyrics if enabled
                    if (this._showLyrics) {
                        this._fetchLyrics(this._currentTrack.title, this._currentTrackDurationSeconds);
                    } else {
                        this._isShowingTrackTitle = false;
                        this._updateLabelText(this._currentTrack.title, false);
                    }
                } else if (this._showLyrics && !this._currentLyrics && !this._lyricsTimeoutId && !this._lyricsRetryTimeoutId && !this._isShowingTrackTitle) {
                    this._fetchLyrics(this._currentTrack.title, this._currentTrackDurationSeconds);
                }

                // Update duration and quality display
                this._updateDurationDisplay();
            } catch (e) {
                logError(e, 'Failed to get track info');
            }
        }

        _clearLyricsRetry() {
            if (this._lyricsRetryTimeoutId) {
                GLib.source_remove(this._lyricsRetryTimeoutId);
                this._lyricsRetryTimeoutId = null;
            }
            this._lyricsRetryIndex = 0;
            this._lyricsRetryStartTime = 0;
        }

        _trackKey(track) {
            return `${track.title}\u0000${track.artist}\u0000${track.album}`;
        }

        _refreshLyrics() {
            if (!this._currentTrack || !this._showLyrics) {
                return;
            }
            this._isShowingTrackTitle = true;
            this._updateLabelText(this._currentTrack.title, false);
            this._fetchLyrics(this._currentTrack.title, this._currentTrackDurationSeconds);
        }

        _scheduleLyricsRetry(title, actualDurationSeconds, trackKey) {
            // Abort if track changed, lyrics are disabled, or lyrics already found
            if (!this._currentTrack || this._trackKey(this._currentTrack) !== trackKey || !this._showLyrics || this._currentLyrics) {
                this._clearLyricsRetry();
                return;
            }

            // Retry intervals: 1s, 3s, 6s, 12s; stop after 30 seconds total limit
            const RETRY_DELAYS = [1000, 3000, 6000, 12000];
            const MAX_RETRY_DURATION_MS = 30000;

            const nowMs = GLib.get_monotonic_time() / 1000;
            if (!this._lyricsRetryStartTime) {
                this._lyricsRetryStartTime = nowMs;
            }
            const elapsedMs = nowMs - this._lyricsRetryStartTime;
            const remainingMs = MAX_RETRY_DURATION_MS - elapsedMs;

            if (this._lyricsRetryIndex < RETRY_DELAYS.length && remainingMs > 1000) {
                const delayMs = Math.min(RETRY_DELAYS[this._lyricsRetryIndex], remainingMs);
                this._lyricsRetryIndex++;

                // Ensure the song title stays displayed while polling
                this._isShowingTrackTitle = true;
                this._updateLabelText(title, false);

                if (this._lyricsRetryTimeoutId) {
                    GLib.source_remove(this._lyricsRetryTimeoutId);
                    this._lyricsRetryTimeoutId = null;
                }

                this._lyricsRetryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                    this._lyricsRetryTimeoutId = null;
                    if (this._currentTrack && this._trackKey(this._currentTrack) === trackKey && this._showLyrics && !this._currentLyrics) {
                        this._fetchLyrics(title, actualDurationSeconds, true);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                // Exhausted retries or 30-second window reached: stop polling
                this._clearLyricsRetry();
                this._isShowingTrackTitle = false;
                this._updateLabelText(title, false);
            }
        }

        _fetchLyrics(title, actualDurationSeconds, isRetry = false) {
            // Clear any existing lyrics display loop timeout
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            if (!isRetry) {
                this._clearLyricsRetry();
                this._lyricsRetryStartTime = GLib.get_monotonic_time() / 1000;
                this._currentLyrics = null;
                this._currentLine = '';
            }

            const track = this._currentTrack;
            if (!track || track.title !== title) {
                return;
            }
            const trackKey = this._trackKey(track);

            this._lyricsClient.getLyrics(
                track.title,
                track.artist,
                track.album,
                actualDurationSeconds || 0
            ).then(lyrics => {
                if (!this._currentTrack || this._trackKey(this._currentTrack) !== trackKey ||
                    !this._showLyrics) {
                    return;
                }
                if (lyrics?.length) {
                    this._clearLyricsRetry();
                    this._currentLyrics = lyrics;
                    this._startLyricsDisplay();
                } else {
                    this._scheduleLyricsRetry(title, actualDurationSeconds, trackKey);
                }
            }).catch(error => {
                if (this._currentTrack && this._trackKey(this._currentTrack) === trackKey) {
                    logError(error, 'Failed to fetch lyrics');
                    this._scheduleLyricsRetry(title, actualDurationSeconds, trackKey);
                }
            });
        }

        _startLyricsDisplay() {
            if (!this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            // Get current playback position
            this._updateCurrentLyricLine();

            // Update lyrics based on configured interval - use 500ms as default
            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._updateCurrentLyricLine();
                return GLib.SOURCE_CONTINUE;
            });
        }

        _updateCurrentLyricLine() {
            if (!this._proxy || !this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            try {
                // Query position via DBus
                this._proxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            // Reply is a tuple containing a variant, extract the int64 value
                            const positionUs = reply.get_child_value(0).get_variant().get_int64();
                            const positionMs = positionUs / 1000; // Convert microseconds to milliseconds

                            if (!this._currentLyrics || this._currentLyrics.length === 0) {
                                return;
                            }

                            // Find the current lyric line
                            let currentLine = this._currentLyrics[0].text;

                            for (let i = this._currentLyrics.length - 1; i >= 0; i--) {
                                if (this._currentLyrics[i].time <= positionMs) {
                                    currentLine = this._currentLyrics[i].text;
                                    break;
                                }
                            }

                            if (currentLine !== this._currentLine) {
                                const isReplacingTitle = this._isShowingTrackTitle;
                                this._isShowingTrackTitle = false;
                                this._currentLine = currentLine;
                                this._updateLabelText(
                                    currentLine,
                                    true,
                                    isReplacingTitle ? 'slide-left' : 'vertical'
                                );
                            }
                        } catch (e) {
                            logError(e, 'Failed to parse position');
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to update lyric line');
            }
        }

        _updateLabelText(text = null, animate = false, animationType = 'vertical') {
            if (!this._label || (typeof this._label.is_finalized === 'function' && this._label.is_finalized())) {
                return;
            }

            if (text !== null) {
                this._currentText = text;
            }

            const display = this._currentText || '';
            const maxLength = this._settings.get_int('max-text-length');
            const newFormattedText = this._truncateText(display, maxLength);

            if (!animate || !this._label.get_text() || this._label.get_text() === newFormattedText) {
                this._label.remove_all_transitions();
                this._label.translation_x = 0;
                this._label.translation_y = 0;
                this._label.opacity = 255;
                this._label.set_text(newFormattedText);
                return;
            }

            if (animationType === 'slide-left') {
                // Horizontal right-to-left slide transition when replacing track title with lyrics
                this._label.remove_all_transitions();
                this._label.translation_y = 0;
                this._label.ease({
                    opacity: 0,
                    translation_x: -24,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!this._label || (typeof this._label.is_finalized === 'function' && this._label.is_finalized())) {
                            return;
                        }
                        this._label.set_text(newFormattedText);
                        this._label.translation_x = 28;
                        this._label.translation_y = 0;
                        this._label.ease({
                            opacity: 255,
                            translation_x: 0,
                            duration: 220,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                });
            } else {
                // Animate rollback / roll-up transition between synced lyric lines
                this._label.remove_all_transitions();
                this._label.translation_x = 0;
                this._label.ease({
                    opacity: 0,
                    translation_y: -8,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!this._label || (typeof this._label.is_finalized === 'function' && this._label.is_finalized())) {
                            return;
                        }
                        this._label.set_text(newFormattedText);
                        this._label.translation_y = 8;
                        this._label.translation_x = 0;
                        this._label.ease({
                            opacity: 255,
                            translation_y: 0,
                            duration: 180,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                });
            }
        }

        _truncateText(text, maxLength) {
            if (text.length <= maxLength) {
                return text;
            }
            return text.substring(0, maxLength - 3) + '...';
        }

        destroy() {
            if (this._settingsSignalId) {
                this._settings.disconnect(this._settingsSignalId);
                this._settingsSignalId = null;
            }

            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            this._clearLyricsRetry();

            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }

            if (this._busSignalId && this._busConnection) {
                this._busConnection.signal_unsubscribe(this._busSignalId);
                this._busSignalId = null;
            }

            this._resetQualityVerification();
            this._spotifyPids = [];
            this._lastTrackKey = null;
            this._currentTrack = null;
            this._currentLyrics = null;
            this._lyricsClient.destroy();
            this._lyricsClient = null;

            if (this._label) {
                this._label.remove_all_transitions();
                this._label = null;
            }

            this._proxy = null;
            this._playerProxy = null;
            this._busConnection = null;
            this._durationItem = null;
            this._playPauseButton = null;
            super.destroy();
        }
    });

export default class MusicLyricsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._indicator = new MusicLyricsIndicator(this._settings);

        this._updatePosition();

        this._settingsSignalId = this._settings.connect('changed::position-in-panel', () => {
            this._updatePosition();
        });
    }

    disable() {
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    _updatePosition() {
        if (!this._indicator) return;

        // Remove from current parent if applied
        if (this._indicator.get_parent()) {
            this._indicator.get_parent().remove_child(this._indicator);
        }

        const position = this._settings.get_string('position-in-panel');

        if (position === 'left') {
            Main.panel._leftBox.add_child(this._indicator);
        } else if (position === 'center') {
            Main.panel._centerBox.add_child(this._indicator);
        } else {
            // Default to right (status area)
            // We use addToStatusArea but need to handle re-adding carefully
            // addToStatusArea destroys existing indicator with same role, but we handle that

            // Since we manually removed it, we can just add it back using the panel method
            // or just use addToStatusArea again (which is safer for right side)
            Main.panel.addToStatusArea('music-lyrics-indicator', this._indicator);
        }

        this._indicator.updateVisibility();
    }
}
