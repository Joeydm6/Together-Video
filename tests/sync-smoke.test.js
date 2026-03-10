const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

const repoRoot = path.join(__dirname, '..');
const ffmpegPath = path.join(repoRoot, 'FFMPEG', 'bin', 'ffmpeg.exe');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1');
        server.on('listening', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
        server.on('error', reject);
    });
}

function createFixtureVideo(outputPath, durationSeconds = 90) {
    const result = spawnSync(
        ffmpegPath,
        [
            '-y',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', `color=c=black:s=320x240:d=${durationSeconds}`,
            '-f', 'lavfi',
            '-i', 'anullsrc=r=48000:cl=stereo',
            '-shortest',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            outputPath
        ],
        { cwd: repoRoot, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, `Failed to create fixture video: ${result.stderr || result.stdout}`);
}

async function waitForServer(url, timeoutMs = 20_000) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch (error) {
            // Server is still starting up.
        }
        await delay(200);
    }

    throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

function installMediaMock(page) {
    return page.addInitScript(() => {
        const stateSymbol = Symbol('tv-media-state');
        const timerSymbol = Symbol('tv-media-timer');
        let pictureInPictureElement = null;

        const ensureState = (element) => {
            if (!element[stateSymbol]) {
                element[stateSymbol] = {
                    currentTime: 0,
                    duration: 90,
                    paused: true,
                    readyState: 4,
                    volume: 1,
                    muted: false
                };
            }
            return element[stateSymbol];
        };

        const emit = (element, eventName) => {
            element.dispatchEvent(new Event(eventName));
        };

        const emitReadyEvents = (element) => {
            for (const eventName of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'progress']) {
                emit(element, eventName);
            }
        };

        Object.defineProperties(HTMLMediaElement.prototype, {
            currentTime: {
                configurable: true,
                get() {
                    return ensureState(this).currentTime;
                },
                set(value) {
                    const state = ensureState(this);
                    state.currentTime = Math.max(0, Math.min(Number(value) || 0, state.duration));
                    emit(this, 'timeupdate');
                }
            },
            duration: {
                configurable: true,
                get() {
                    return ensureState(this).duration;
                }
            },
            paused: {
                configurable: true,
                get() {
                    return ensureState(this).paused;
                }
            },
            readyState: {
                configurable: true,
                get() {
                    return ensureState(this).readyState;
                }
            },
            buffered: {
                configurable: true,
                get() {
                    const state = ensureState(this);
                    return {
                        length: 1,
                        start: () => 0,
                        end: () => state.duration
                    };
                }
            },
            volume: {
                configurable: true,
                get() {
                    return ensureState(this).volume;
                },
                set(value) {
                    ensureState(this).volume = Number(value);
                    emit(this, 'volumechange');
                }
            },
            muted: {
                configurable: true,
                get() {
                    return ensureState(this).muted;
                },
                set(value) {
                    ensureState(this).muted = Boolean(value);
                    emit(this, 'volumechange');
                }
            }
        });

        HTMLMediaElement.prototype.load = function load() {
            const state = ensureState(this);
            state.readyState = 4;
            queueMicrotask(() => emitReadyEvents(this));
        };

        HTMLMediaElement.prototype.play = function play() {
            const state = ensureState(this);
            state.paused = false;
            clearInterval(this[timerSymbol]);
            emit(this, 'play');
            queueMicrotask(() => emit(this, 'playing'));

            this[timerSymbol] = setInterval(() => {
                if (state.paused) {
                    return;
                }

                state.currentTime = Math.min(state.duration, state.currentTime + 0.25);
                emit(this, 'timeupdate');

                if (state.currentTime >= state.duration) {
                    state.paused = true;
                    clearInterval(this[timerSymbol]);
                    emit(this, 'pause');
                    emit(this, 'ended');
                }
            }, 250);

            return Promise.resolve();
        };

        HTMLMediaElement.prototype.pause = function pause() {
            const state = ensureState(this);
            if (state.paused) {
                return;
            }

            state.paused = true;
            clearInterval(this[timerSymbol]);
            emit(this, 'pause');
        };

        HTMLMediaElement.prototype.canPlayType = () => 'probably';
        Object.defineProperty(document, 'pictureInPictureEnabled', {
            configurable: true,
            get: () => true
        });
        Object.defineProperty(document, 'pictureInPictureElement', {
            configurable: true,
            get: () => pictureInPictureElement
        });
        HTMLVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture() {
            pictureInPictureElement = this;
            emit(this, 'enterpictureinpicture');
            return Promise.resolve(this);
        };
        document.exitPictureInPicture = () => {
            const active = pictureInPictureElement;
            pictureInPictureElement = null;
            if (active) {
                emit(active, 'leavepictureinpicture');
            }
            return Promise.resolve();
        };
    });
}

test('two players stay in sync for play, seek and pause', { timeout: 120_000 }, async (t) => {
    assert.ok(fs.existsSync(ffmpegPath), `FFmpeg fixture generator not found at ${ffmpegPath}`);
    assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'togethervideo-sync-'));
    const mediaRoot = path.join(tempRoot, 'media');
    const cacheRoot = path.join(tempRoot, 'cache');
    const progressPath = path.join(tempRoot, 'progress.json');
    const seasonDir = path.join(mediaRoot, 'Series', 'Smoke Show', 'Season 1');
    const episodeOne = path.join(seasonDir, 'Smoke Show S01E01.mp4');
    const episodeTwo = path.join(seasonDir, 'Smoke Show S01E02.mp4');
    const englishSubtitle = path.join(seasonDir, 'Smoke Show S01E01.en.srt');
    const dutchSubtitle = path.join(seasonDir, 'Smoke Show S01E01.nl.srt');

    await fsp.mkdir(seasonDir, { recursive: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await fsp.writeFile(progressPath, '{}');
    createFixtureVideo(episodeOne);
    createFixtureVideo(episodeTwo);
    await fsp.writeFile(
        englishSubtitle,
        '1\n00:00:00,000 --> 00:00:01,000\nHello from English subtitles.\n\n2\n00:00:01,000 --> 00:00:02,000\nEnglish subtitles shifted.\n',
        'utf8'
    );
    await fsp.writeFile(
        dutchSubtitle,
        '1\n00:00:00,000 --> 00:00:01,000\nHallo vanuit Nederlandse ondertitels.\n\n2\n00:00:01,000 --> 00:00:02,000\nNederlandse ondertitels verschoven.\n',
        'utf8'
    );

    const port = await getFreePort();
    const serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            VIDEOS_DIRECTORY: mediaRoot,
            CACHE_DIRECTORY: cacheRoot,
            PROGRESS_FILE_PATH: progressPath,
            TMDB_API_KEY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let serverLogs = '';
    serverProcess.stdout.on('data', chunk => {
        serverLogs += chunk.toString();
    });
    serverProcess.stderr.on('data', chunk => {
        serverLogs += chunk.toString();
    });

    const cleanup = async () => {
        if (!serverProcess.killed) {
            serverProcess.kill('SIGTERM');
            await delay(500);
            if (!serverProcess.killed) {
                serverProcess.kill('SIGKILL');
            }
        }
        await fsp.rm(tempRoot, { recursive: true, force: true });
    };

    t.after(cleanup);

    await waitForServer(`http://127.0.0.1:${port}/`);

    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true
    });

    t.after(async () => {
        await browser.close();
    });

    const pageOne = await browser.newPage();
    const pageTwo = await browser.newPage();

    await installMediaMock(pageOne);
    await installMediaMock(pageTwo);

    const videoParam = encodeURIComponent('Series/Smoke Show/Season 1/Smoke Show S01E01.mp4');
    const playerUrl = `http://127.0.0.1:${port}/player.html?video=${videoParam}`;

    await pageOne.goto(playerUrl, { waitUntil: 'domcontentloaded' });
    await pageOne.waitForFunction(() => new URLSearchParams(window.location.search).get('room'));

    const sharedRoomUrl = await pageOne.evaluate(() => window.location.href);

    await pageTwo.goto(sharedRoomUrl, { waitUntil: 'domcontentloaded' });

    await pageOne.locator('#join-button').click();
    await pageTwo.locator('#join-button').click();

    await pageOne.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'));
    await pageTwo.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'));
    await pageOne.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await pageTwo.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    const roomCode = await pageOne.evaluate(() => new URL(window.location.href).searchParams.get('room'));
    await pageOne.waitForFunction(() => !!document.getElementById('pip-button'));
    await pageOne.waitForFunction(() => document.getElementById('diagnostics-role').textContent.length > 0);
    await pageTwo.waitForFunction(() => document.getElementById('diagnostics-browser').textContent.length > 0);
    await pageOne.waitForFunction(() => document.getElementById('presence-status').textContent.includes('Partner'));
    await pageTwo.waitForFunction(() => document.getElementById('presence-status').textContent.includes('Partner'));
    await pageOne.waitForFunction(() => document.getElementById('prev-episode-button').disabled === true);
    await pageOne.waitForFunction(() => document.getElementById('next-episode-button-bar').disabled === false);
    await pageOne.waitForFunction(() => Array.from(document.querySelectorAll('#subtitle-buttons-container button')).some(button => button.textContent.includes('English')));
    await pageTwo.waitForFunction(() => Array.from(document.querySelectorAll('#subtitle-buttons-container button')).some(button => button.textContent.includes('English')));
    await pageOne.waitForFunction(() => document.querySelector('#subtitle-buttons-container button.active .subtitle-button-title')?.textContent === 'English');
    await pageTwo.waitForFunction(() => document.querySelector('#subtitle-buttons-container button.active .subtitle-button-title')?.textContent === 'English');
    await pageOne.evaluate(() => {
        const video = document.getElementById('video-player');
        video.currentTime = 0.95;
    });
    await pageTwo.evaluate(() => {
        const video = document.getElementById('video-player');
        video.currentTime = 0.95;
    });
    await pageOne.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('Hello from English subtitles.'));
    await pageTwo.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('Hello from English subtitles.'));

    await pageOne.locator('#settings-button').click();
    await pageOne.evaluate(() => {
        const subtitleButton = Array.from(document.querySelectorAll('#subtitle-buttons-container button'))
            .find(button => button.querySelector('.subtitle-button-title')?.textContent === 'Nederlands');
        subtitleButton?.click();
    });
    await pageTwo.waitForFunction(() => document.querySelector('#subtitle-buttons-container button.active .subtitle-button-title')?.textContent === 'Nederlands');

    await pageOne.locator('#settings-button').click();
    await pageOne.locator('#subtitle-offset-forward-fine').click();
    await pageOne.waitForFunction(() => document.getElementById('subtitle-offset-display').textContent === '+100ms');
    await pageTwo.waitForFunction(() => document.getElementById('subtitle-offset-display').textContent === '+100ms');
    await pageOne.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('Nederlandse ondertitels verschoven.'));
    await pageTwo.waitForFunction(() => document.getElementById('subtitle-container').textContent.includes('Nederlandse ondertitels verschoven.'));

    await pageTwo.locator('#settings-button').click();
    await pageTwo.evaluate(() => {
        const subtitleButton = Array.from(document.querySelectorAll('#subtitle-buttons-container button'))
            .find(button => button.querySelector('.subtitle-button-title')?.textContent === 'Subtitles off');
        subtitleButton?.click();
    });
    await pageOne.waitForFunction(() => document.querySelector('#subtitle-buttons-container button.active .subtitle-button-title')?.textContent === 'Subtitles off');

    await pageOne.locator('#play-pause-button').click();

    await pageOne.waitForFunction(() => document.getElementById('video-player').paused === false);
    await pageTwo.waitForFunction(() => document.getElementById('video-player').paused === false);

    await pageOne.locator('#forward-button').click();

    await pageOne.waitForFunction(() => document.getElementById('video-player').currentTime >= 9.5);
    await pageTwo.waitForFunction(() => document.getElementById('video-player').currentTime >= 9.5);

    const timesAfterSeek = await Promise.all([
        pageOne.evaluate(() => document.getElementById('video-player').currentTime),
        pageTwo.evaluate(() => document.getElementById('video-player').currentTime)
    ]);

    assert.ok(
        Math.abs(timesAfterSeek[0] - timesAfterSeek[1]) < 1.5,
        `Players drifted too far after seek: ${timesAfterSeek.join(' vs ')}\n${serverLogs}`
    );

    await pageTwo.evaluate(() => {
        document.getElementById('video-player').currentTime = 2;
    });

    await delay(2500);

    const timesAfterHeartbeat = await Promise.all([
        pageOne.evaluate(() => document.getElementById('video-player').currentTime),
        pageTwo.evaluate(() => document.getElementById('video-player').currentTime)
    ]);

    assert.ok(
        Math.abs(timesAfterHeartbeat[0] - timesAfterHeartbeat[1]) < 1.25,
        `Players drifted too far after heartbeat correction: ${timesAfterHeartbeat.join(' vs ')}\n${serverLogs}`
    );

    await pageTwo.evaluate(() => {
        document.getElementById('video-player').currentTime = 1;
    });

    await pageTwo.locator('#settings-button').click();
    await pageTwo.locator('#resync-button').click();
    await delay(1500);

    const timesAfterManualResync = await Promise.all([
        pageOne.evaluate(() => document.getElementById('video-player').currentTime),
        pageTwo.evaluate(() => document.getElementById('video-player').currentTime)
    ]);

    assert.ok(
        Math.abs(timesAfterManualResync[0] - timesAfterManualResync[1]) < 1.25,
        `Players drifted too far after manual resync: ${timesAfterManualResync.join(' vs ')}\n${serverLogs}`
    );

    await pageOne.evaluate(() => {
        document.getElementById('video-player').dispatchEvent(new Event('ended'));
    });
    await pageOne.waitForFunction(() => document.getElementById('next-episode-countdown').style.display === 'flex');
    await pageTwo.waitForFunction(() => document.getElementById('next-episode-countdown').style.display === 'flex');
    await pageTwo.locator('#next-episode-cancel').click();
    await pageOne.waitForFunction(() => document.getElementById('next-episode-countdown').style.display !== 'flex');
    await pageTwo.waitForFunction(() => document.getElementById('next-episode-countdown').style.display !== 'flex');

    await pageTwo.locator('#play-pause-button').click();

    await pageOne.waitForFunction(() => document.getElementById('video-player').paused === true);
    await pageTwo.waitForFunction(() => document.getElementById('video-player').paused === true);

    const finalState = await Promise.all([
        pageOne.evaluate(() => ({
            paused: document.getElementById('video-player').paused,
            time: document.getElementById('video-player').currentTime
        })),
        pageTwo.evaluate(() => ({
            paused: document.getElementById('video-player').paused,
            time: document.getElementById('video-player').currentTime
        }))
    ]);

    assert.equal(finalState[0].paused, true, `Page one did not pause.\n${serverLogs}`);
    assert.equal(finalState[1].paused, true, `Page two did not pause.\n${serverLogs}`);
    assert.ok(
        Math.abs(finalState[0].time - finalState[1].time) < 1.5,
        `Players drifted too far after pause: ${JSON.stringify(finalState)}\n${serverLogs}`
    );

    const diagnosticsPage = await browser.newPage();
    t.after(async () => {
        await diagnosticsPage.close();
    });
    await diagnosticsPage.goto(`http://127.0.0.1:${port}/diagnostics.html?room=${encodeURIComponent(roomCode)}`, { waitUntil: 'domcontentloaded' });
    await diagnosticsPage.waitForFunction((expectedRoom) => {
        const roomCards = document.querySelectorAll('#shared-rooms .diag-card');
        const telemetryItems = document.querySelectorAll('#recent-telemetry .telemetry-item');
        return Array.from(roomCards).some(card => card.textContent.includes(expectedRoom)) && telemetryItems.length > 0;
    }, roomCode);
});

test('players recover from reconnects and leader handoff', { timeout: 150_000 }, async (t) => {
    assert.ok(fs.existsSync(ffmpegPath), `FFmpeg fixture generator not found at ${ffmpegPath}`);
    assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'togethervideo-remote-'));
    const mediaRoot = path.join(tempRoot, 'media');
    const cacheRoot = path.join(tempRoot, 'cache');
    const progressPath = path.join(tempRoot, 'progress.json');
    const seasonDir = path.join(mediaRoot, 'Series', 'Remote Smoke', 'Season 1');
    const episodeOne = path.join(seasonDir, 'Remote Smoke S01E01.mp4');
    const episodeTwo = path.join(seasonDir, 'Remote Smoke S01E02.mp4');

    await fsp.mkdir(seasonDir, { recursive: true });
    await fsp.mkdir(cacheRoot, { recursive: true });
    await fsp.writeFile(progressPath, '{}');
    createFixtureVideo(episodeOne);
    createFixtureVideo(episodeTwo);

    const port = await getFreePort();
    const serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            VIDEOS_DIRECTORY: mediaRoot,
            CACHE_DIRECTORY: cacheRoot,
            PROGRESS_FILE_PATH: progressPath,
            TMDB_API_KEY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let serverLogs = '';
    serverProcess.stdout.on('data', chunk => {
        serverLogs += chunk.toString();
    });
    serverProcess.stderr.on('data', chunk => {
        serverLogs += chunk.toString();
    });

    const cleanup = async () => {
        if (!serverProcess.killed) {
            serverProcess.kill('SIGTERM');
            await delay(500);
            if (!serverProcess.killed) {
                serverProcess.kill('SIGKILL');
            }
        }
        await fsp.rm(tempRoot, { recursive: true, force: true });
    };

    t.after(cleanup);

    await waitForServer(`http://127.0.0.1:${port}/`);

    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true
    });

    t.after(async () => {
        await browser.close();
    });

    const leaderContext = await browser.newContext();
    const followerContext = await browser.newContext();

    t.after(async () => {
        await Promise.allSettled([
            leaderContext.close(),
            followerContext.close()
        ]);
    });

    const leaderPage = await leaderContext.newPage();
    const followerPage = await followerContext.newPage();

    await installMediaMock(leaderPage);
    await installMediaMock(followerPage);

    const videoParam = encodeURIComponent('Series/Remote Smoke/Season 1/Remote Smoke S01E01.mp4');
    const playerUrl = `http://127.0.0.1:${port}/player.html?video=${videoParam}`;

    await leaderPage.goto(playerUrl, { waitUntil: 'domcontentloaded' });
    await leaderPage.waitForFunction(() => new URLSearchParams(window.location.search).get('room'));
    const sharedRoomUrl = await leaderPage.evaluate(() => window.location.href);
    await followerPage.goto(sharedRoomUrl, { waitUntil: 'domcontentloaded' });

    await leaderPage.locator('#join-button').click();
    await followerPage.locator('#join-button').click();

    await leaderPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'));
    await followerPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'));
    await leaderPage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);
    await followerPage.waitForFunction(() => document.getElementById('video-player').readyState >= 2);

    await leaderPage.locator('#play-pause-button').click();
    await leaderPage.waitForFunction(() => document.getElementById('video-player').paused === false);
    await followerPage.waitForFunction(() => document.getElementById('video-player').paused === false);

    await delay(1200);
    await followerContext.setOffline(true);

    await followerPage.waitForFunction(() => document.getElementById('sync-status-badge').textContent === 'Reconnecting', null, { timeout: 20_000 });
    await leaderPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('1'), null, { timeout: 20_000 });

    await followerContext.setOffline(false);

    await leaderPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'), null, { timeout: 30_000 });
    await followerPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'), null, { timeout: 30_000 });

    await delay(3000);

    const timesAfterReconnect = await Promise.all([
        leaderPage.evaluate(() => document.getElementById('video-player').currentTime),
        followerPage.evaluate(() => document.getElementById('video-player').currentTime)
    ]);

    assert.ok(
        Math.abs(timesAfterReconnect[0] - timesAfterReconnect[1]) < 1.5,
        `Players drifted too far after reconnect: ${timesAfterReconnect.join(' vs ')}\n${serverLogs}`
    );

    await leaderContext.close();

    await followerPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('1'), null, { timeout: 20_000 });

    const replacementContext = await browser.newContext();
    t.after(async () => {
        await Promise.allSettled([replacementContext.close()]);
    });

    const replacementPage = await replacementContext.newPage();
    await installMediaMock(replacementPage);
    await replacementPage.goto(sharedRoomUrl, { waitUntil: 'domcontentloaded' });
    await replacementPage.locator('#join-button').click();

    await followerPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'), null, { timeout: 20_000 });
    await replacementPage.waitForFunction(() => document.getElementById('user-count-display').textContent.includes('2'), null, { timeout: 20_000 });
    await followerPage.waitForFunction(() => document.getElementById('sync-status-badge').textContent === 'Sync leader', null, { timeout: 20_000 });
    await replacementPage.waitForFunction(() => document.getElementById('sync-status-badge').textContent === 'Synced', null, { timeout: 20_000 });

    await followerPage.locator('#play-pause-button').click();
    await followerPage.waitForFunction(() => document.getElementById('video-player').paused === false);
    await replacementPage.waitForFunction(() => document.getElementById('video-player').paused === false);

    await followerPage.locator('#forward-button').click();
    await followerPage.waitForFunction(() => document.getElementById('video-player').currentTime >= 9.5);
    await replacementPage.waitForFunction(() => document.getElementById('video-player').currentTime >= 9.5);

    const timesAfterHandoff = await Promise.all([
        followerPage.evaluate(() => document.getElementById('video-player').currentTime),
        replacementPage.evaluate(() => document.getElementById('video-player').currentTime)
    ]);

    assert.ok(
        Math.abs(timesAfterHandoff[0] - timesAfterHandoff[1]) < 1.5,
        `Players drifted too far after leader handoff: ${timesAfterHandoff.join(' vs ')}\n${serverLogs}`
    );
});
