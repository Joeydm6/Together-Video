import { detectCapabilities, isAndroidDevice, isMobileDevice } from './player/capabilities.js';
import { appendDiagnosticEvent, formatDiagnosticsText } from './player/diagnostics.js';
import { createTelemetryReporter } from './player/telemetry.js';

const READY=2;
const PLAY_DRIFT=1.25;
const SEEK_DRIFT=0.75;
const HEARTBEAT_DRIFT=0.6;
const SNAPSHOT_SEEK_SETTLE_DRIFT=0.18;
const PROGRESS_MS=15000;
const UI_HIDE_MS=3000;
const MOBILE_UI_HIDE_MS=2200;
const LEADER_SYNC_MS=1000;
const HEARTBEAT_GRACE_MS=4500;
const SYNC_REQUEST_RETRY_MS=2500;
const SEEK_SETTLE_MS=1600;
const SEEK_BUFFER_SYNC_COOLDOWN_MS=1400;
const SEEK_FOLLOWUP_RESYNC_MS=1900;
const SEEK_FULLSCREEN_EXIT_GRACE_MS=1500;
const SUBTITLE_OFFSET_STEP_MS=100;
const WATCHED_AT=95;
const playIcon='<svg id="play-icon" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const pauseIcon='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const volumeHighIcon='<svg xmlns="http://www.w3.org/2000/svg" height="22" viewBox="0 0 24 24" width="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const volumeMutedIcon='<svg xmlns="http://www.w3.org/2000/svg" height="22" viewBox="0 0 24 24" width="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 5V5z"/><path d="m22 2-20 20"/></svg>';
const fsEnter='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const fsExit='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
const DEFAULT_SUBTITLE_BOTTOM_PX=178;
const LEGACY_SUBTITLE_BOTTOMS=new Set([145,150,155]);
const DEFAULT_PIP_SUBTITLE_LINE=65;
const mobile=()=>isMobileDevice(navigator);
const android=()=>isAndroidDevice(navigator);
const encodePath=v=>v.split('/').map(encodeURIComponent).join('/');
const fmt=s=>{if(!Number.isFinite(s)||s<0)return'00:00';const t=Math.floor(s),h=Math.floor(t/3600),m=Math.floor((t%3600)/60),r=t%60;return h>0?`${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;};
const prettyEpisodeName=fileName=>{const base=fileName.replace(/\.[^.]+$/,'').replace(/[._]+/g,' ').trim(),match=base.match(/S(\d{1,2})E(\d{1,2})/i);if(!match)return fileName;const episodeNumber=Number.parseInt(match[2],10);let title=base.slice(match.index+match[0].length).trim();title=title.replace(/\b(2160p|1080p|720p|480p|amzn|web[ -]?dl|webrip|bluray|brrip|ddp\d(?:[ .]\d)?|dd\d(?:[ .]\d)?|aac(?:[ .]?\d(?:[ .]\d)?)?|h[ .]?264|h[ .]?265|x264|x265|hevc|proper|repack|nf|dsnp|max|atvp|flux|rawr)\b/ig,' ').replace(/[\[\]\(\)-]+/g,' ').replace(/\b\d\b$/g,' ').replace(/\b[h]\b$/ig,' ').replace(/\s+/g,' ').trim();return title?`Episode ${episodeNumber}: ${title}`:`Episode ${episodeNumber}`;};
const cueTime=t=>t.replace(',','.').split(':').reduce((a,p)=>a*60+Number.parseFloat(p||'0'),0);
const parseVtt=text=>{const lines=text.replace(/\r/g,'').split('\n'),cues=[];for(let i=0;i<lines.length;i+=1){if(!lines[i].includes('-->'))continue;const[start,end]=lines[i].split(' --> '),parts=[];i+=1;while(i<lines.length&&lines[i].trim()!==''){parts.push(lines[i]);i+=1;}cues.push({start:cueTime(start.trim()),end:cueTime(end.split(' ')[0].trim()),text:parts.join('<br>')});}return cues;};
const parseSrt=text=>text.replace(/\r/g,'').trim().split(/\n\s*\n/g).map(block=>{const lines=block.split('\n').map(line=>line.trimEnd()),timeLine=lines.find(line=>line.includes('-->'));if(!timeLine)return null;const[start,end]=timeLine.split(' --> ');return{start:cueTime(start.trim()),end:cueTime(end.trim()),text:lines.slice(lines.indexOf(timeLine)+1).filter(Boolean).join('<br>')};}).filter(Boolean);

document.addEventListener('DOMContentLoaded',()=>{
const $=id=>document.getElementById(id);
const els={
joinOverlay:$('join-overlay'),
joinButton:$('join-button'),
joinHeading:$('join-heading'),
joinCopy:$('join-copy'),
joinVideoTitle:$('join-video-title'),
joinRoomCode:$('join-room-code'),
joinMetaMode:$('join-meta-mode'),
joinStatusSelf:$('join-status-self'),
joinStatusPartner:$('join-status-partner'),
joinStatusStream:$('join-status-stream'),
joinCopyButton:$('join-copy-button'),
joinDebugTrace:$('join-debug-trace'),
joinDebugLines:$('join-debug-lines'),
playerContainer:document.querySelector('.player-container'),
videoWrapper:$('video-wrapper'),
mobileShell:$('mobile-player-shell'),
mobileStatusRow:$('mobile-status-row'),
mobileBadgeRow:$('mobile-badge-row'),
mobileInfoStack:$('mobile-info-stack'),
uiContainer:$('player-ui-container'),
video:$('video-player'),
videoTitle:$('video-title'),
clickInterceptor:$('click-interceptor'),
mobilePlayToggle:$('mobile-play-toggle'),
playPause:$('play-pause-button'),
rewind:$('rewind-button'),
forward:$('forward-button'),
prev:$('prev-episode-button'),
next:$('next-episode-button-bar'),
seekBar:$('seek-bar'),
seekProgress:$('seek-progress-bar'),
seekTooltip:$('seek-tooltip'),
bufferedBar:$('buffered-bar'),
time:$('time-display'),
volumeButton:$('volume-button'),
volumeBar:$('volume-bar'),
pipButton:$('pip-button'),
settingsButton:$('settings-button'),
settingsPanel:$('combined-settings-panel'),
settingsBackButton:$('settings-back-button'),
closeSettingsButton:$('close-settings-button'),
settingsPanelKicker:$('settings-panel-kicker'),
settingsPanelTitle:$('settings-panel-title'),
settingsPanelSubtitle:$('settings-panel-subtitle'),
settingsHomeQuality:$('settings-home-quality'),
settingsHomeSubtitles:$('settings-home-subtitles'),
settingsHomeAudio:$('settings-home-audio'),
settingsHomePlayback:$('settings-home-playback'),
settingsSummaryQuality:$('settings-summary-quality'),
settingsSummarySubtitles:$('settings-summary-subtitles'),
settingsSummaryAudio:$('settings-summary-audio'),
settingsSummaryPlayback:$('settings-summary-playback'),
settingsHomeView:$('settings-home-view'),
playbackMode:$('playback-mode-select'),
audioGroup:$('audio-settings-group'),
audioSelect:$('audio-track-select'),
subtitlesGroup:$('subtitles-settings-group'),
subtitleButtons:$('subtitle-buttons-container'),
subtitleContainer:$('subtitle-container'),
subtitleOffsetControls:$('subtitle-offset-controls'),
subtitleBack:$('subtitle-offset-backward-fine'),
subtitleForward:$('subtitle-offset-forward-fine'),
subtitleOffset:$('subtitle-offset-display'),
subtitleReset:$('subtitle-offset-reset'),
subtitleStyleSize:$('subtitle-style-size'),
subtitleStyleSizeValue:$('subtitle-style-size-value'),
subtitleStyleColor:$('subtitle-style-color'),
subtitleStyleBg:$('subtitle-style-bg'),
subtitleStyleBgValue:$('subtitle-style-bg-value'),
subtitleStylePosition:$('subtitle-style-position'),
subtitleStylePositionValue:$('subtitle-style-position-value'),
subtitleStylePreviewText:$('subtitle-style-preview-text'),
subtitleStyleReset:$('subtitle-style-reset'),
resyncButton:$('resync-button'),
closeSettingsFooter:$('close-settings-footer'),
installGroup:$('app-settings-group'),
installButton:$('install-app-button-player'),
roomCode:$('room-code-display'),
diagnosticsRole:$('diagnostics-role'),
diagnosticsUsers:$('diagnostics-users'),
diagnosticsLatency:$('diagnostics-latency'),
diagnosticsDrift:$('diagnostics-drift'),
diagnosticsHeartbeat:$('diagnostics-heartbeat'),
diagnosticsConnection:$('diagnostics-connection'),
diagnosticsDevice:$('diagnostics-device'),
diagnosticsBrowser:$('diagnostics-browser'),
presence:$('presence-status'),
countdown:$('next-episode-countdown'),
countdownSeconds:$('next-episode-countdown-seconds'),
countdownTitle:$('next-episode-countdown-title'),
countdownPlayNow:$('next-episode-play-now'),
countdownCancel:$('next-episode-cancel'),
prompt:$('play-prompt-overlay'),
portraitGate:$('portrait-player-gate'),
portraitGateTitle:$('portrait-gate-title'),
portraitGateRotate:$('portrait-gate-rotate'),
status:$('status-message'),
userCount:$('user-count-display'),
inviteMenu:$('invite-menu'),
inviteMenuMeta:$('invite-menu-meta'),
inviteMenuCopy:$('invite-menu-copy'),
webcamDock:$('webcam-dock'),
webcamRemoteCard:$('webcam-remote-card'),
webcamRemoteVideo:$('webcam-remote-video'),
webcamRemotePlaceholder:$('webcam-remote-placeholder'),
webcamLocalCard:$('webcam-local-card'),
webcamLocalVideo:$('webcam-local-video'),
webcamLocalPlaceholder:$('webcam-local-placeholder'),
webcamStatusCopy:$('webcam-status-copy'),
webcamToggleButton:$('webcam-toggle-button'),
syncStatus:$('sync-status-badge'),
fullscreen:$('fullscreen-button'),
breadcrumb:$('breadcrumb-nav'),
back:$('fullscreen-back-button')
};
const subtitleColorSwatches=[...document.querySelectorAll('[data-subtitle-color]')];
const subtitleBackgroundButtons=[...document.querySelectorAll('[data-subtitle-bg]')];
const params=new URLSearchParams(window.location.search);
let videoFile=params.get('video');
const initialRoomCode=params.get('room')?.trim().toUpperCase()||null;
const openedFromInviteLink=Boolean(initialRoomCode);
const interactionKey='tv-has-interacted';
let deferredInstallPrompt=null;
const installDisplayModeQuery=window.matchMedia?window.matchMedia('(display-mode: standalone)'):null;
const prefersReducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false;
const socket=io({autoConnect:false,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:3000,timeout:20000,transports:['websocket','polling']});
const reportTelemetry=createTelemetryReporter();
const state={activeCountdownTimer:null,activeCountdownVideo:null,activeSeekId:null,activeSubtitleUrl:null,activeSyncRequestId:null,autoSubtitleStatus:'idle',availableAudioTracks:[],availableSubtitles:[],awaitingSyncSnapshot:false,bufferIssueCount:0,bufferRecoveryDone:false,capabilities:detectCapabilities(),currentUsers:0,cues:[],diagnosticEvents:[],diagnosticsTimer:null,duration:0,hasJoined:false,healthTimer:null,ignoreFullscreenExitUntil:0,inviteMenuOpen:false,isLeader:false,isPartnerReady:true,isProblematic:false,isScrubbing:false,isWatchingAlone:false,lastBroadcastReadyState:null,lastBufferIssueAt:0,lastDriftMs:null,lastHeartbeatAt:0,lastSeekAt:0,lastSnapshotRequestAt:0,latencyMs:null,leaderTimer:null,lobbyPrepared:false,lobbyPreparing:false,lobbySyncTimer:null,markedWatched:false,mediaPrimed:false,nativeSubtitleTrack:null,nextAvailable:false,nextVideo:null,openingWarmupReady:false,pendingBootstrapSnapshot:null,pendingSeekResyncTimer:null,parentHref:'/',playbackModeOverride:null,playerReady:false,portraitGateActive:false,postSeekSyncTimer:null,presenceLabel:'Preparing invite link...',preferDesktopFullscreen:false,prevAvailable:false,prevVideo:null,preloadedVideos:new Set(),progressTimer:null,pseudoFullscreen:false,queue:Promise.resolve(),returnToLobbyAfterFullscreenExit:false,roomCode:initialRoomCode,seekOffset:0,seekPreviewClientX:null,seekPreviewTime:null,seekSettleUntil:0,selectedAudioTrackIndex:null,sessionStarted:false,settingsView:'home',shareUrl:initialRoomCode?`${window.location.origin}/player.html?room=${encodeURIComponent(initialRoomCode)}`:null,sourceLoadingCount:0,sourceReady:false,snapshotRetryTimer:null,sourceToken:0,startingSession:false,startupTrace:[],statusTimer:null,subtitleOffsetMs:0,syncRequestAttempts:0,uiLockedHidden:false,uiTimer:null,userMuted:false,viewingPrimed:false};
const settingsViews=[...document.querySelectorAll('.settings-view')];
const mobileMovableElements=[els.syncStatus,els.userCount,els.presence,els.status,els.uiContainer];
const originalMobilePositions=new Map(mobileMovableElements.map(element=>[element,{parent:element.parentNode,nextSibling:element.nextSibling}]));
const motionTimers=new WeakMap();
let settingsPanelFrame=0;
let settingsPanelHideTimer=0;
let updatePortraitGate=()=>{};
let requestLandscapeViewing=async()=>{};
if(!videoFile&&!state.roomCode){document.body.innerHTML='<div class="status-fullscreen"><h1>No video specified.</h1><a href="/" class="back-link">Back to Video List</a></div>';return;}
const subtitleKey=()=>`subtitle-selection-${videoFile}`;
const subtitleOffsetKey=()=>`subtitle-offset-${videoFile}`;
const subtitleStyleKey=()=>`subtitle-style-settings`;
const audioTrackKey=()=>`audio-track-${videoFile}`;
const playbackModePreferenceKey='videoPlaybackModePreference';
const settingsPanelOpen=()=>els.settingsPanel?.classList.contains('is-open');
const storageGet=(storage,key)=>{try{return storage?.getItem?.(key)??null;}catch(error){console.debug('[STORAGE_GET]',key,error?.message||error);return null;}};
const storageSet=(storage,key,value)=>{try{storage?.setItem?.(key,value);return true;}catch(error){console.debug('[STORAGE_SET]',key,error?.message||error);return false;}};
const storageRemove=(storage,key)=>{try{storage?.removeItem?.(key);return true;}catch(error){console.debug('[STORAGE_REMOVE]',key,error?.message||error);return false;}};
const duration=()=>state.duration>0?state.duration:(Number.isFinite(els.video.duration)?els.video.duration:0);
const currentTime=()=>state.seekOffset>0?els.video.currentTime+state.seekOffset:els.video.currentTime;
const normalizePlaybackMode=value=>value==='data-saver'?'data-saver':'original';
const savedPlaybackMode=()=>storageGet(localStorage,playbackModePreferenceKey)==='true'?normalizePlaybackMode(storageGet(localStorage,'videoPlaybackMode')):'original';
const currentPlaybackMode=()=>state.playbackModeOverride||savedPlaybackMode();
const effectiveQuality=()=>currentPlaybackMode()==='data-saver'?'480p':'auto';
const autoplayRequested=()=>params.get('autoplay')==='true';
const buildPlayerUrl=(mediaPath=videoFile,roomCode=state.roomCode)=>{
const next=new URL('/player.html',window.location.origin);
if(mediaPath)next.searchParams.set('video',mediaPath);
if(roomCode)next.searchParams.set('room',roomCode);
return `${next.pathname}?${next.searchParams.toString()}`;
};
const absolutePlayerUrl=(mediaPath=videoFile,roomCode=state.roomCode)=>`${window.location.origin}${buildPlayerUrl(mediaPath,roomCode)}`;
const canCopyInvite=()=>Boolean(state.shareUrl)&&state.currentUsers<=1;
const iosCompat=()=>state.capabilities.profile==='ios-compat';
const iosStartupStrict=()=>false;
const lobbyReadyForStart=()=>Boolean(state.lobbyPrepared&&state.mediaPrimed&&openingSecondsReady()&&!state.lobbyPreparing);
const canStartFromLobby=()=>{
if(!state.hasJoined||state.lobbyPreparing)return false;
if(state.currentUsers<=1)return Boolean(state.lobbyPrepared);
return Boolean(lobbyReadyForStart()&&state.isPartnerReady);
};
const landscapeViewingReady=()=>!mobile()||nativeFullscreenActive()||window.matchMedia('(orientation: landscape)').matches;
const canReusePrimedViewing=()=>state.capabilities.profile==='ios-compat'&&state.viewingPrimed&&state.lobbyPrepared;
const lockLandscapeOrientation=async()=>{if(!mobile())return;try{if(window.screen?.orientation?.lock)await window.screen.orientation.lock('landscape');}catch(error){console.debug('[ORIENTATION_LOCK]',error?.message||error);}};
const unlockOrientation=()=>{try{window.screen?.orientation?.unlock?.();}catch(error){console.debug('[ORIENTATION_UNLOCK]',error?.message||error);}};
const pulseElement=element=>{if(!element||prefersReducedMotion)return;const timer=motionTimers.get(element);if(timer)window.clearTimeout(timer);element.classList.remove('motion-pulse');void element.offsetWidth;element.classList.add('motion-pulse');motionTimers.set(element,window.setTimeout(()=>{element.classList.remove('motion-pulse');motionTimers.delete(element);},430));};
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const wait=ms=>new Promise(resolve=>window.setTimeout(resolve,ms));
const waitForPlaybackStart=async(timeoutMs=1800,baselineTime=currentTime())=>new Promise(resolve=>{
let settled=false;
let timeoutId=0;
const finish=result=>{
if(settled)return;
settled=true;
window.clearTimeout(timeoutId);
els.video.removeEventListener('playing',onPlaying);
els.video.removeEventListener('timeupdate',onTimeUpdate);
resolve(result);
};
const onPlaying=()=>finish(true);
const onTimeUpdate=()=>{if(currentTime()>baselineTime+0.04)finish(true);};
timeoutId=window.setTimeout(()=>finish(false),timeoutMs);
els.video.addEventListener('playing',onPlaying,{once:true});
els.video.addEventListener('timeupdate',onTimeUpdate);
});
const waitForSourceLoadsToSettle=async(timeoutMs=2600)=>{
const startedAt=Date.now();
while(state.sourceLoadingCount>0&&(Date.now()-startedAt)<timeoutMs){
await wait(60);
}
return state.sourceLoadingCount===0;
};
const traceStartupStep=step=>{
const label=String(step||'').trim();
if(!label)return;
const stamp=new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
state.startupTrace=[...state.startupTrace,`${stamp} ${label}`].slice(-6);
renderJoinOverlay();
};
const inferTone=value=>{const text=String(value||'').toLowerCase();if(/reconnect|restored|retrying/.test(text))return'warm';if(/buffer|waiting|syncing|countdown/.test(text))return'warning';if(/error|failed|unable|left|lost/.test(text))return'danger';if(/synced|connected|ready|copied|opened|installed|resumed|playback paused|position synchronized|resync/.test(text))return'cool';return'';};
const backgroundPresetLabel=value=>{const amount=Number.parseFloat(value)||0;if(amount>=0.3)return'Solid';if(amount>=0.1)return'Soft';return'Clear';};
const positionPresetLabel=value=>{const offset=Number.parseInt(value,10)||DEFAULT_SUBTITLE_BOTTOM_PX;if(offset<=130)return'Low';if(offset>=195)return'High';return'Standard';};
const syncSubtitleStylePresetButtons=style=>{const normalizedColor=String(style.color||'#ffffff').toLowerCase();subtitleColorSwatches.forEach(button=>button.classList.toggle('is-active',String(button.dataset.subtitleColor||'').toLowerCase()===normalizedColor));const backgroundValue=String(Number.parseFloat(style.backgroundAlpha)||0);subtitleBackgroundButtons.forEach(button=>button.classList.toggle('is-active',String(Number.parseFloat(button.dataset.subtitleBg||'0'))===backgroundValue));};
const getBufferedTime=()=>{try{const ranges=els.video?.buffered;return ranges&&ranges.length>0?ranges.end(ranges.length-1):0;}catch{return 0;}};
const bufferedAhead=()=>Math.max(0,getBufferedTime()-Math.max(0,currentTime()));
const openingSecondsTargetBuffer=()=>{
if(currentPlaybackMode()==='data-saver')return mobile()?0.65:0.55;
if(state.capabilities.profile==='ios-compat')return state.currentUsers>1?1.75:1.25;
return mobile()?1.05:0.85;
};
const openingSecondsReady=()=>{
if(state.openingWarmupReady)return true;
if(iosStartupStrict()){
if(currentPlaybackMode()==='data-saver'&&state.lobbyPrepared&&minimalPrepareReady())return true;
return Boolean(els.video.readyState>=READY&&bufferedAhead()>=openingSecondsTargetBuffer());
}
if(els.video.readyState>=READY)return true;
return bufferedAhead()>=openingSecondsTargetBuffer();
};
const hideSeekPreview=()=>{state.seekPreviewClientX=null;state.seekPreviewTime=null;els.seekTooltip?.classList.remove('visible');};
const previewTimeFromClientX=clientX=>{const rect=els.seekBar?.getBoundingClientRect();const total=duration();if(!rect||!total)return null;const ratio=clamp((clientX-rect.left)/Math.max(1,rect.width),0,1);return total*ratio;};
const updateSeekVisuals=(previewTime=state.seekPreviewTime,clientX=state.seekPreviewClientX)=>{const total=duration();const progressPercent=total>0?clamp((currentTime()/total)*100,0,100):0;const bufferedPercent=total>0?clamp((getBufferedTime()/total)*100,0,100):0;if(els.seekProgress)els.seekProgress.style.width=`${progressPercent}%`;if(els.bufferedBar)els.bufferedBar.style.width=`${bufferedPercent}%`;if(!els.seekTooltip||mobile()||!Number.isFinite(previewTime)||previewTime===null||total<=0){els.seekTooltip?.classList.remove('visible');return;}const rect=els.seekBar.getBoundingClientRect();const ratio=clientX!==null?clamp((clientX-rect.left)/Math.max(1,rect.width),0,1):clamp(previewTime/total,0,1);els.seekTooltip.textContent=fmt(previewTime);els.seekTooltip.style.left=`${ratio*rect.width}px`;els.seekTooltip.classList.add('visible');};
const status=(msg,ms=2000,persist=false)=>{els.status.textContent=msg;els.status.dataset.tone=inferTone(msg);els.status.classList.add('visible');pulseElement(els.status);clearTimeout(state.statusTimer);state.statusTimer=null;if(!persist){state.statusTimer=window.setTimeout(()=>{els.status.classList.remove('visible');state.statusTimer=null;},ms);}};
const hideStatus=()=>{clearTimeout(state.statusTimer);state.statusTimer=null;els.status.classList.remove('visible');};
const ensureInlinePreviewPlayback=element=>{
if(!element)return;
element.autoplay=true;
element.muted=true;
element.playsInline=true;
element.setAttribute('autoplay','true');
element.setAttribute('muted','true');
element.setAttribute('playsinline','true');
element.setAttribute('webkit-playsinline','true');
try{
const playPromise=element.srcObject?element.play():Promise.resolve();
if(playPromise&&typeof playPromise.catch==='function')playPromise.catch(()=>{});
}catch(error){
console.debug('[WEBCAM_PREVIEW_PLAY]',error?.message||error);
}
};
const setMediaElementStream=(element,stream)=>{if(!element)return;if(element.srcObject!==stream)element.srcObject=stream||null;};
const countVideoTracks=stream=>{if(!stream||typeof stream.getVideoTracks!=='function')return 0;try{return (stream.getVideoTracks()||[]).length;}catch{return 0;}};
const renderWebcamUi=snapshot=>{
const view=snapshot||{};
const remoteTrackCount=countVideoTracks(view.remoteStream);
const localTrackCount=countVideoTracks(view.localStream);
const remoteVisible=Boolean(view.remoteEnabled||remoteTrackCount);
const localVisible=Boolean(view.localEnabled);
if(els.webcamStatusCopy)els.webcamStatusCopy.textContent=view.statusLabel||'Join the room first to share your camera.';
if(els.webcamToggleButton){
els.webcamToggleButton.textContent=view.buttonLabel||'Share Camera';
els.webcamToggleButton.disabled=Boolean(view.busy||!view.canToggle);
}
if(els.webcamDock){
els.webcamDock.classList.toggle('is-visible',Boolean(view.dockVisible));
els.webcamDock.dataset.layout=!remoteVisible&&localVisible?'local-only':'stacked';
}
if(els.webcamRemoteCard){
els.webcamRemoteCard.hidden=!remoteVisible;
els.webcamRemoteCard.classList.toggle('has-video',remoteTrackCount>0);
}
if(els.webcamLocalCard){
els.webcamLocalCard.hidden=!localVisible;
els.webcamLocalCard.classList.toggle('has-video',localTrackCount>0);
}
if(els.webcamRemotePlaceholder)els.webcamRemotePlaceholder.textContent=view.remoteEnabled?'Partner camera is connecting...':'Partner camera is off.';
if(els.webcamLocalPlaceholder)els.webcamLocalPlaceholder.textContent=view.localEnabled?'Starting your preview...':'Your camera preview appears here.';
setMediaElementStream(els.webcamRemoteVideo,view.remoteStream||null);
setMediaElementStream(els.webcamLocalVideo,view.localStream||null);
ensureInlinePreviewPlayback(els.webcamRemoteVideo);
ensureInlinePreviewPlayback(els.webcamLocalVideo);
};
let webcamController={
cleanup:async()=>{},
handleAnswer:async()=>{},
handleDisconnect:()=>{},
handleHangup:()=>{},
handleIceCandidate:async()=>{},
handleOffer:async()=>{},
handlePartnerCameraState:()=>{},
handlePartnerLeft:()=>{},
handleWebcamStateSync:()=>{},
setJoined:()=>{},
setLeader:()=>{},
setParticipantCount:()=>{},
toggleCamera:async()=>false
};
const initializeWebcamController=async()=>{
try{
const webcamModule=await import('./player/webrtc.js');
const createWebcamController=webcamModule?.createWebcamController;
if(typeof createWebcamController!=='function')throw new Error('createWebcamController export missing');
webcamController=createWebcamController({
socket,
onStateChange:renderWebcamUi,
onToast:(message,ms=1800)=>status(message,ms)
});
}catch(error){
console.error('[WEBCAM_INIT]',error);
renderWebcamUi({canToggle:false,statusLabel:'Camera sharing is not available on this browser.',buttonLabel:'Share Camera',dockVisible:false});
}
};
const isStandaloneApp=()=>((installDisplayModeQuery?.matches)??false)||window.navigator.standalone===true;
const updateInstallButton=()=>{if(!els.installGroup||!els.installButton)return;const visible=Boolean(deferredInstallPrompt)&&!isStandaloneApp();els.installGroup.style.display=visible?'block':'none';els.installButton.disabled=!visible;};
const settingsViewMeta={
home:{kicker:'Playback',title:'Settings',subtitle:'Choose what you want to adjust.'},
quality:{kicker:'Playback',title:'Quality',subtitle:'Pick the stream that fits this screen best.'},
subtitles:{kicker:'Playback',title:'Subtitles',subtitle:'Tracks, timing and subtitle style for the shared session.'},
audio:{kicker:'Playback',title:'Audio',subtitle:'Select the active audio track for this episode.'},
playback:{kicker:'Playback',title:'Session',subtitle:'Sync tools for the shared room.'}
};
const currentPlaybackModeLabel=()=>currentPlaybackMode()==='data-saver'?'Data Save Mode':'Original quality';
const activeSubtitleLabel=()=>{if(!state.activeSubtitleUrl)return'Subtitles off';const match=state.availableSubtitles.find(item=>item.url===state.activeSubtitleUrl);const label=match?.lang||'Subtitle track';return state.subtitleOffsetMs!==0?`${label} (${state.subtitleOffsetMs>0?'+':''}${state.subtitleOffsetMs}ms)`:label;};
const activeAudioLabel=()=>selectedAudioTrack()?.label||selectedAudioTrack()?.language||(state.availableAudioTracks.length>1?'Choose audio track':'Original audio');
const playbackOptionsLabel=()=>state.currentUsers>1?'Room sync':'Playback tools';
const renderSettingsSummaries=()=>{
if(els.settingsSummaryQuality)els.settingsSummaryQuality.textContent=currentPlaybackModeLabel();
if(els.settingsSummarySubtitles)els.settingsSummarySubtitles.textContent=activeSubtitleLabel();
if(els.settingsSummaryAudio)els.settingsSummaryAudio.textContent=activeAudioLabel();
if(els.settingsSummaryPlayback)els.settingsSummaryPlayback.textContent=playbackOptionsLabel();
if(els.settingsHomeAudio)els.settingsHomeAudio.hidden=state.availableAudioTracks.length<=1;
if(els.settingsHomeSubtitles)els.settingsHomeSubtitles.hidden=els.subtitlesGroup?.style.display==='none';
};
const setSettingsView=view=>{
const next=settingsViewMeta[view]?view:'home';
state.settingsView=next;
settingsViews.forEach(node=>node.classList.toggle('is-active',node.id===`settings-view-${next}`||(!node.dataset.settingsView&&next==='home')));
const meta=settingsViewMeta[next];
if(els.settingsPanelKicker)els.settingsPanelKicker.textContent=meta.kicker;
if(els.settingsPanelTitle)els.settingsPanelTitle.textContent=meta.title;
if(els.settingsPanelSubtitle)els.settingsPanelSubtitle.textContent=meta.subtitle;
if(els.settingsBackButton)els.settingsBackButton.hidden=next==='home';
renderSettingsSummaries();
};
const openSettingsPanel=(view='home')=>{if(!els.settingsPanel)return;clearTimeout(settingsPanelHideTimer);cancelAnimationFrame(settingsPanelFrame);document.body.classList.add('settings-open');els.settingsPanel.style.display='block';setSettingsView(view);els.settingsPanel.classList.add('is-open');};
const closeSettingsPanel=()=>{if(!els.settingsPanel)return;clearTimeout(settingsPanelHideTimer);cancelAnimationFrame(settingsPanelFrame);els.settingsPanel.classList.remove('is-open');document.body.classList.remove('settings-open');setSettingsView('home');settingsPanelHideTimer=window.setTimeout(()=>{if(!settingsPanelOpen())els.settingsPanel.style.display='none';},180);};
const hideUi=()=>{if(settingsPanelOpen()||els.prompt.style.display==='flex')return;state.uiLockedHidden=true;els.videoWrapper.classList.remove('ui-visible');};
const showUi=()=>{state.uiLockedHidden=false;els.videoWrapper.classList.add('ui-visible');clearTimeout(state.uiTimer);if(settingsPanelOpen()||els.prompt.style.display==='flex'||els.video.paused)return;const hideDelay=mobile()?MOBILE_UI_HIDE_MS:UI_HIDE_MS;state.uiTimer=window.setTimeout(()=>hideUi(),hideDelay);};
const clearLobbySync=()=>{clearInterval(state.lobbySyncTimer);state.lobbySyncTimer=null;};
const clearPostSeekSync=()=>{window.clearTimeout(state.postSeekSyncTimer);state.postSeekSyncTimer=null;};
const clearPendingSeekResync=()=>{window.clearTimeout(state.pendingSeekResyncTimer);state.pendingSeekResyncTimer=null;};
const createSeekId=()=>`seek-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const createSyncRequestId=()=>`sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const seekWindowActive=()=>Date.now()<state.seekSettleUntil;
const registerSeekWindow=(seekId=null,{allowFallback=false}={})=>{
const now=Date.now();
state.lastSeekAt=now;
state.seekSettleUntil=now+SEEK_SETTLE_MS;
state.ignoreFullscreenExitUntil=Math.max(state.ignoreFullscreenExitUntil,now+SEEK_FULLSCREEN_EXIT_GRACE_MS);
if(seekId)state.activeSeekId=seekId;
clearPendingSeekResync();
if(!allowFallback)return;
state.pendingSeekResyncTimer=window.setTimeout(()=>{
state.pendingSeekResyncTimer=null;
if(!state.hasJoined||state.isLeader||state.currentUsers<2||!socket.connected||state.awaitingSyncSnapshot||seekWindowActive())return;
requestLiveSync('seek-settle-fallback',{silent:true,force:true});
},SEEK_FOLLOWUP_RESYNC_MS);
};
const matchingSeekSnapshot=data=>Boolean(data?.seekId&&state.activeSeekId&&data.seekId===state.activeSeekId&&seekWindowActive());
const matchesActiveSyncRequest=data=>!(state.awaitingSyncSnapshot&&state.activeSyncRequestId&&data?.requestId&&data.requestId!==state.activeSyncRequestId);
const emitLobbyReadyState=({force=false}={})=>{if(!socket.connected||!state.hasJoined)return;const nextReady=lobbyReadyForStart();if(!force&&state.lastBroadcastReadyState===nextReady)return;state.lastBroadcastReadyState=nextReady;socket.emit('readyStateUpdate',{isReady:nextReady});};
const requestLobbyStateSync=()=>{if(!socket.connected||!state.hasJoined)return;emitLobbyReadyState({force:true});socket.emit('requestReadyStateSync');};
const updateLobbySyncLoop=()=>{clearLobbySync();if(!socket.connected||!state.hasJoined||state.sessionStarted||state.currentUsers<2)return;state.lobbySyncTimer=window.setInterval(()=>{if(document.visibilityState==='visible')requestLobbyStateSync();},2500);};
const scheduleLeaderSeekSync=(reason='seek',seekId=null)=>{
if(!state.hasJoined||!state.isLeader||state.currentUsers<2||!socket.connected)return;
clearPostSeekSync();
state.postSeekSyncTimer=window.setTimeout(()=>{
socket.emit('syncSnapshot',{seekId,time:currentTime(),paused:els.video.paused,subtitleUrl:state.activeSubtitleUrl,subtitleOffsetMs:state.subtitleOffsetMs,audioTrackIndex:state.selectedAudioTrackIndex});
traceStartupStep(`seek:stabilize ${reason}`);
},420);
};
const followerLobbySyncReady=()=>Boolean(state.hasJoined&&socket.connected&&state.currentUsers>1&&!state.isLeader&&state.lobbyPrepared&&openingSecondsReady()&&!state.sessionStarted&&els.joinOverlay?.style.display!=='none');
const requestFollowerLobbySync=(reason,{force=false}={})=>{if(!followerLobbySyncReady())return;state.pendingBootstrapSnapshot=null;requestLiveSync(reason,{silent:true,force});};
const setJoinStatus=(element,title,detail,stateName='waiting')=>{if(!element)return;element.dataset.state=stateName;const titleNode=element.querySelector('.join-status-title');const detailNode=element.querySelector('.join-status-detail');if(titleNode)titleNode.textContent=title;if(detailNode)detailNode.textContent=detail;};
const reconcileLobbyPreparationState=()=>{
if(!state.lobbyPreparing)return false;
if(!(state.lobbyPrepared||state.mediaPrimed||state.playerReady||openingSecondsReady()))return false;
state.lobbyPreparing=false;
traceStartupStep('prepare:reconciled');
emitLobbyReadyState({force:true});
return true;
};
const renderJoinOverlay=()=>{reconcileLobbyPreparationState();updateLobbySyncLoop();if(!els.joinOverlay||els.joinOverlay.style.display==='none')return;const roomCode=state.roomCode||'------';const partnerConnected=state.currentUsers>1;const partnerReady=partnerConnected&&state.isPartnerReady;const waitingForRoomOwner=openedFromInviteLink&&state.currentUsers<=1&&!state.isLeader;const streamReady=openingSecondsReady();if(els.joinVideoTitle)els.joinVideoTitle.textContent=prettyEpisodeName(videoFile.split('/').pop()||videoFile);if(els.joinRoomCode)els.joinRoomCode.textContent=roomCode;if(els.joinMetaMode)els.joinMetaMode.textContent=currentPlaybackMode()==='data-saver'?'Data Save Mode':'Original quality';if(els.joinHeading){if(state.startingSession)els.joinHeading.textContent=state.currentUsers>1?'Starting together...':'Starting now...';else if(!state.lobbyPrepared)els.joinHeading.textContent='Get ready together';else if(!state.hasJoined)els.joinHeading.textContent='Joining room...';else if(waitingForRoomOwner)els.joinHeading.textContent='Waiting for the host';else if(state.currentUsers<=1)els.joinHeading.textContent='Ready when you are';else if(!state.isPartnerReady)els.joinHeading.textContent='Almost there';else if(state.isLeader)els.joinHeading.textContent='Everything is lined up';else els.joinHeading.textContent='Ready for your partner';}if(els.joinCopy){if(state.startingSession)els.joinCopy.textContent='Both screens are lined up. Starting from the same point now.';else if(!state.lobbyPrepared)els.joinCopy.textContent='Settle both screens first, then start with the opening seconds already in place.';else if(!state.hasJoined)els.joinCopy.textContent='Bringing this screen into the room and getting the start ready.';else if(waitingForRoomOwner)els.joinCopy.textContent='This invite is waiting for the original screen to connect before the session can start.';else if(state.currentUsers<=1)els.joinCopy.textContent='This screen is ready. Share the invite when you want, or start now and let the other person join smoothly after.';else if(!state.isPartnerReady)els.joinCopy.textContent='Both screens are here. Give it a moment so the start lands cleanly for both of you.';else if(state.isLeader)els.joinCopy.textContent='Both screens look good. Start whenever you want.';else els.joinCopy.textContent='This screen is ready. Waiting for the other viewer to start.';}setJoinStatus(els.joinStatusSelf,'Your device',state.lobbyPreparing?'Getting this screen settled in...':(state.lobbyPrepared?'This screen is ready for a smooth start.':'One quick tap and this screen is good to go.'),state.lobbyPrepared?'ready':'waiting');setJoinStatus(els.joinStatusPartner,'Partner',waitingForRoomOwner?'Waiting for the host screen to connect.':(state.currentUsers<=1?'Waiting for the other screen to show up.':(partnerReady?'The other screen is ready too.':'The other screen is still settling in.')),partnerReady?'ready':'waiting');setJoinStatus(els.joinStatusStream,'Opening seconds',streamReady?'The start is already lined up.':'Loading the opening seconds so the start feels clean.',streamReady?'ready':'waiting');if(els.joinButton){let label='Get Ready';let disabled=false;if(state.startingSession){label=state.currentUsers>1?'Starting together...':'Starting now...';disabled=true;}else if(state.lobbyPreparing){label='Getting Ready...';disabled=true;}else if(!state.lobbyPrepared){label='Get Ready';}else if(!state.hasJoined){label='Joining room...';disabled=true;}else if(waitingForRoomOwner){label='Waiting for Host';disabled=true;}else if(state.currentUsers<=1){label='Start Watching';}else if(!state.isPartnerReady){label=state.isLeader?'Waiting for Partner':'Getting Ready...';disabled=true;}else if(!state.isLeader){label='Waiting for Start';disabled=true;}else label='Start Together';els.joinButton.textContent=label;els.joinButton.disabled=disabled;}if(els.joinCopyButton){els.joinCopyButton.hidden=!Boolean(state.shareUrl);els.joinCopyButton.textContent=partnerConnected?'Copy invite again':'Copy Invite Link';}if(els.joinDebugTrace&&els.joinDebugLines){const showTrace=state.capabilities.profile==='ios-compat'&&state.startupTrace.length>0;els.joinDebugTrace.hidden=!showTrace;els.joinDebugTrace.classList.toggle('is-visible',showTrace);els.joinDebugLines.textContent=showTrace?state.startupTrace.join('\n'):'';}};
const showJoinOverlay=()=>{if(!els.joinOverlay)return;document.body.classList.add('join-overlay-visible');els.joinOverlay.style.display='flex';els.joinOverlay.classList.remove('is-exiting');renderJoinOverlay();updatePortraitGate();};
const hideJoinOverlay=({immediate=false}={})=>{if(!els.joinOverlay)return;clearLobbySync();document.body.classList.remove('join-overlay-visible');if(immediate){els.joinOverlay.style.display='none';els.joinOverlay.classList.remove('is-exiting');updatePortraitGate();return;}if(els.joinOverlay.style.display==='none'||els.joinOverlay.classList.contains('is-exiting'))return;els.joinOverlay.classList.add('is-exiting');window.setTimeout(()=>{els.joinOverlay.style.display='none';els.joinOverlay.classList.remove('is-exiting');updatePortraitGate();},180);};
const nativeFullscreenActive=()=>!!(document.fullscreenElement||document.webkitFullscreenElement||document.mozFullScreenElement||document.msFullscreenElement||els.video?.webkitDisplayingFullscreen);
const fullscreenActive=()=>nativeFullscreenActive()||state.pseudoFullscreen;
const compactLandscapeActive=()=>mobile()&&window.matchMedia('(orientation: landscape)').matches&&window.innerHeight<=520;
const syncMobileLayout=()=>{const compactLandscape=compactLandscapeActive();const mobileLayout=window.matchMedia('(max-width: 600px)').matches||compactLandscape;const useMobileShell=mobileLayout&&!compactLandscape&&!fullscreenActive();document.body.classList.toggle('mobile-layout',mobileLayout);document.body.classList.toggle('compact-landscape',compactLandscape);document.body.classList.toggle('fullscreen-active',fullscreenActive());if(useMobileShell){if(els.syncStatus&&els.mobileBadgeRow&&els.syncStatus.parentNode!==els.mobileBadgeRow)els.mobileBadgeRow.appendChild(els.syncStatus);if(els.userCount&&els.mobileBadgeRow&&els.userCount.parentNode!==els.mobileBadgeRow)els.mobileBadgeRow.appendChild(els.userCount);if(els.presence&&els.mobileInfoStack&&els.presence.parentNode!==els.mobileInfoStack)els.mobileInfoStack.appendChild(els.presence);if(els.status&&els.mobileInfoStack&&els.status.parentNode!==els.mobileInfoStack)els.mobileInfoStack.appendChild(els.status);if(els.uiContainer&&els.mobileShell&&els.uiContainer.parentNode!==els.mobileShell)els.mobileShell.appendChild(els.uiContainer);return;}for(const element of mobileMovableElements){const original=originalMobilePositions.get(element);if(!element||!original)continue;if(original.nextSibling&&original.nextSibling.parentNode===original.parent)original.parent.insertBefore(element,original.nextSibling);else original.parent.appendChild(element);}};
const updatePlayPause=()=>{const icon=els.video.paused?playIcon:pauseIcon;els.playPause.innerHTML=icon;if(els.mobilePlayToggle)els.mobilePlayToggle.innerHTML=icon;};
const updateVolume=()=>{els.volumeButton.innerHTML=(els.video.muted||els.video.volume===0)?volumeMutedIcon:volumeHighIcon;};
const setReady=(ready,reason='unknown')=>{const nextReady=iosStartupStrict()?Boolean(openingSecondsReady()):Boolean(ready||openingSecondsReady());const changed=state.playerReady!==nextReady;state.playerReady=nextReady;if(changed){console.log(`[READY] ${nextReady} (${reason})`);traceStartupStep(`ready:${nextReady?'yes':'no'} ${reason}`);}emitLobbyReadyState();renderJoinOverlay();if(nextReady&&state.pendingBootstrapSnapshot&&state.lobbyPrepared&&!state.sessionStarted){const snapshot=state.pendingBootstrapSnapshot;state.pendingBootstrapSnapshot=null;void enqueue(()=>applyBootstrapSnapshot(snapshot));return;}if(nextReady)requestFollowerLobbySync(`ready-${reason}`,{force:changed});};
const syncUi=(time=currentTime())=>{if(!state.isScrubbing)els.seekBar.value=String(Math.max(0,time));els.seekBar.max=String(duration());els.time.textContent=`${fmt(time)} / ${fmt(duration())}`;updateSeekVisuals();};
const saveProgress=()=>{if(state.hasJoined)socket.emit('saveProgress',{videoFile,time:currentTime()});};
const enqueue=task=>{state.queue=state.queue.then(()=>task()).catch(error=>console.error('[SYNC]',error));return state.queue;};
const updateLeaderSync=()=>{clearInterval(state.leaderTimer);state.leaderTimer=null;if(!state.hasJoined||!state.isLeader||state.currentUsers<2)return;state.leaderTimer=window.setInterval(()=>{if(els.video.paused||state.isScrubbing)return;socket.emit('leaderTimeUpdate',{time:currentTime(),paused:els.video.paused,timestamp:Date.now()});},LEADER_SYNC_MS);};
const clearSnapshotRetry=()=>{clearTimeout(state.snapshotRetryTimer);state.snapshotRetryTimer=null;};
const closeInviteMenu=()=>{state.inviteMenuOpen=false;if(els.userCount){els.userCount.setAttribute('aria-expanded','false');delete els.userCount.dataset.open;}if(els.inviteMenu)els.inviteMenu.hidden=true;};
const positionInviteMenu=()=>{if(!els.inviteMenu||els.inviteMenu.hidden||!els.userCount)return;const rect=els.userCount.getBoundingClientRect();const menuRect=els.inviteMenu.getBoundingClientRect();const gap=10;const left=Math.max(12,Math.min(window.innerWidth-menuRect.width-12,rect.right-menuRect.width));const top=Math.min(window.innerHeight-menuRect.height-12,rect.bottom+gap);els.inviteMenu.style.left=`${left}px`;els.inviteMenu.style.top=`${Math.max(12,top)}px`;};
const renderInviteMenu=()=>{const available=canCopyInvite();if(els.userCount){if(available){els.userCount.dataset.clickable='true';els.userCount.setAttribute('aria-haspopup','menu');els.userCount.setAttribute('aria-expanded',String(state.inviteMenuOpen));els.userCount.title='Open invite options';}else{delete els.userCount.dataset.clickable;els.userCount.removeAttribute('aria-haspopup');els.userCount.setAttribute('aria-expanded','false');els.userCount.title=state.currentUsers>1?'Watching together':'Viewer count';}}if(els.inviteMenuMeta)els.inviteMenuMeta.textContent=state.roomCode?`Room ${state.roomCode}`:'Copy the invite link for your partner.';if(!available){closeInviteMenu();return;}if(els.inviteMenu){els.inviteMenu.hidden=!state.inviteMenuOpen;positionInviteMenu();}};
const toggleInviteMenu=()=>{if(!canCopyInvite()){closeInviteMenu();return;}state.inviteMenuOpen=!state.inviteMenuOpen;renderInviteMenu();};
const renderPresence=()=>{els.presence.textContent=state.presenceLabel;els.presence.dataset.tone=inferTone(state.presenceLabel);els.presence.title=state.presenceLabel||'';delete els.presence.dataset.clickable;renderInviteMenu();};
const presence=(label,{toast=false,ms=1800}={})=>{const changed=state.presenceLabel!==label;state.presenceLabel=label;renderPresence();if(changed)pulseElement(els.presence);if(toast)status(label,ms);};
const logDiagnosticEvent=(type,detail='')=>{state.diagnosticEvents=appendDiagnosticEvent(state.diagnosticEvents,type,detail,12);};
const trackPlayback=(type,detail='',metadata={})=>{reportTelemetry({type,detail,roomCode:state.roomCode,videoFile,...metadata});};
const recordPlaybackEvent=(type,detail='',metadata={})=>{logDiagnosticEvent(type,detail);trackPlayback(type,detail,metadata);};
const normalizeSubtitleBottomValue=value=>{const parsed=Number.parseInt(value,10);if(!Number.isFinite(parsed))return DEFAULT_SUBTITLE_BOTTOM_PX;if(LEGACY_SUBTITLE_BOTTOMS.has(parsed))return DEFAULT_SUBTITLE_BOTTOM_PX;return clamp(parsed,90,220);};
const defaultSubtitleStyle=()=>({fontSize:state.capabilities.profile==='ios-compat'?'1.05rem':state.capabilities.profile==='mobile-safe'?'1.15rem':state.capabilities.profile==='tablet-balanced'?'1.25rem':'1.35rem',color:'#ffffff',backgroundAlpha:state.capabilities.profile==='mobile-safe'?0.15:state.capabilities.profile==='ios-compat'||state.capabilities.profile==='tablet-balanced'?0.1:0,bottom:`${DEFAULT_SUBTITLE_BOTTOM_PX}px`});
const loadSavedSubtitleStyle=()=>{try{const saved=JSON.parse(storageGet(localStorage,subtitleStyleKey())||'null');if(!saved)return defaultSubtitleStyle();return{...defaultSubtitleStyle(),...saved,bottom:`${normalizeSubtitleBottomValue(saved.bottom)}px`};}catch{return defaultSubtitleStyle();}};
const syncSubtitleStyleControls=style=>{const fontSize=Number.parseFloat(style.fontSize)||1.2;const backgroundAlpha=Number.parseFloat(style.backgroundAlpha)||0;const bottom=normalizeSubtitleBottomValue(style.bottom);els.subtitleStyleSize.value=String(fontSize);els.subtitleStyleColor.value=String(style.color||'#ffffff').toLowerCase();els.subtitleStyleBg.value=String(backgroundAlpha);els.subtitleStylePosition.value=String(bottom);if(els.subtitleStyleSizeValue)els.subtitleStyleSizeValue.textContent=`${fontSize.toFixed(2)}x`;if(els.subtitleStyleBgValue)els.subtitleStyleBgValue.textContent=backgroundPresetLabel(backgroundAlpha);if(els.subtitleStylePositionValue)els.subtitleStylePositionValue.textContent=positionPresetLabel(bottom);syncSubtitleStylePresetButtons({color:els.subtitleStyleColor.value,backgroundAlpha});};
const applySubtitleStyle=style=>{const normalized={fontSize:style.fontSize||defaultSubtitleStyle().fontSize,color:String(style.color||'#ffffff').toLowerCase(),backgroundAlpha:Number.parseFloat(style.backgroundAlpha)||0,bottom:`${normalizeSubtitleBottomValue(style.bottom)}px`};document.documentElement.style.setProperty('--cue-font-size',`${Number.parseFloat(normalized.fontSize)}rem`);document.documentElement.style.setProperty('--cue-color',normalized.color);document.documentElement.style.setProperty('--cue-bg-alpha',String(normalized.backgroundAlpha));document.documentElement.style.setProperty('--cue-bottom',normalized.bottom);document.documentElement.style.setProperty('--cue-padding',normalized.backgroundAlpha>0?'0.2rem 0.45rem':'0');syncSubtitleStyleControls(normalized);storageSet(localStorage,subtitleStyleKey(),JSON.stringify(normalized));renderSettingsSummaries();};
const supportsNativeAudioTracks=()=>!!(els.video&&'audioTracks'in els.video&&els.video.audioTracks&&typeof els.video.audioTracks.length==='number');
const directPlaybackMode=()=>!state.isProblematic&&currentPlaybackMode()==='original';
const setPlaybackModeState=(mode,{persist=false}={})=>{const normalized=normalizePlaybackMode(mode);state.playbackModeOverride=persist?null:normalized;if(persist){storageSet(localStorage,'videoPlaybackMode',normalized);storageSet(localStorage,playbackModePreferenceKey,'true');}syncPlaybackModeUi();};
const selectedAudioTrack=()=>state.availableAudioTracks.find(track=>track.index===state.selectedAudioTrackIndex)||null;
const defaultAudioTrackIndex=()=>{const stored=Number.parseInt(storageGet(localStorage,audioTrackKey())||'',10);if(Number.isInteger(stored)&&state.availableAudioTracks.some(track=>track.index===stored))return stored;const fallback=state.availableAudioTracks.find(track=>track.isDefault)||state.availableAudioTracks[0];return fallback?.index??null;};
const applyNativeAudioTrackSelection=()=>{if(!supportsNativeAudioTracks())return false;const target=selectedAudioTrack();if(!target)return false;const tracks=els.video.audioTracks;if(target.order>=tracks.length)return false;for(let i=0;i<tracks.length;i+=1)tracks[i].enabled=i===target.order;return true;};
const renderAudioTracks=()=>{if(!els.audioGroup||!els.audioSelect)return;els.audioSelect.innerHTML='';if(state.availableAudioTracks.length<=1){els.audioGroup.style.display='none';renderSettingsSummaries();return;}els.audioGroup.style.display='block';state.availableAudioTracks.forEach(track=>{const option=document.createElement('option');option.value=String(track.index);option.textContent=track.label||track.language||`Track ${track.order+1}`;if(track.index===state.selectedAudioTrackIndex)option.selected=true;els.audioSelect.appendChild(option);});els.audioSelect.disabled=state.availableAudioTracks.length<=1;renderSettingsSummaries();};
const broadcastAudioTrackSelection=index=>{const track=state.availableAudioTracks.find(item=>item.index===index);if(state.hasJoined)socket.emit('audioTrackSelectionUpdate',{videoFile,audioTrackIndex:index,label:track?.label||track?.language||'Track',timestamp:Date.now()});};
const setAudioTrackSelection=async(index,{broadcast=false,silent=false}={})=>{const parsed=index===null||index===undefined||index===''?null:Number.parseInt(index,10);if(parsed!==null&&!state.availableAudioTracks.some(track=>track.index===parsed))return;const changed=state.selectedAudioTrackIndex!==parsed;state.selectedAudioTrackIndex=parsed;if(parsed===null)storageRemove(localStorage,audioTrackKey());else storageSet(localStorage,audioTrackKey(),String(parsed));renderAudioTracks();if(!changed){if(directPlaybackMode())applyNativeAudioTrackSelection();return;}let reloaded=false;if(directPlaybackMode()){if(!applyNativeAudioTrackSelection()){setPlaybackModeState('data-saver');status('Using Data Save Mode for audio switching',2500);await loadSource({time:currentTime(),resume:!els.video.paused,reason:'audio-track-change'});reloaded=true;}}else{await loadSource({time:currentTime(),resume:!els.video.paused,reason:'audio-track-change'});reloaded=true;}if(directPlaybackMode())applyNativeAudioTrackSelection();if(broadcast)broadcastAudioTrackSelection(parsed);if(!silent){const track=selectedAudioTrack();status(track?`Audio track: ${track.label}`:(reloaded?'Audio track updated':'Audio track updated'),1800);}};
const completeSyncRequest=()=>{state.awaitingSyncSnapshot=false;state.activeSyncRequestId=null;state.syncRequestAttempts=0;clearSnapshotRetry();};
const requestLiveSync=(reason='partner-sync',{silent=false,force=false}={})=>{if(!state.hasJoined||state.isLeader||state.currentUsers<2||!socket.connected)return;const now=Date.now();if(!force&&state.awaitingSyncSnapshot&&(now-state.lastSnapshotRequestAt)<SYNC_REQUEST_RETRY_MS)return;const requestId=createSyncRequestId();state.awaitingSyncSnapshot=true;state.activeSyncRequestId=requestId;state.lastSnapshotRequestAt=now;state.syncRequestAttempts+=1;socket.emit('requestSyncSnapshot',{requestId,reason});if(!silent)status(reason==='manual'?'Requesting full resync...':'Syncing with partner...',1500);clearSnapshotRetry();state.snapshotRetryTimer=window.setTimeout(()=>{if(!state.awaitingSyncSnapshot||!socket.connected||state.isLeader||state.currentUsers<2)return;if(state.syncRequestAttempts>=3){status('Partner sync is taking longer than expected',2500);clearSnapshotRetry();return;}requestLiveSync(reason,{silent:true,force:true});},SYNC_REQUEST_RETRY_MS);};
const updateSyncStatus=()=>{let label='';if(!socket.connected&&state.hasJoined)label='Reconnecting';else if(state.currentUsers>1&&!state.isPartnerReady)label='Partner buffering';else if(state.currentUsers>1&&state.isLeader)label='Sync leader';else if(state.currentUsers>1)label='Synced';const changed=els.syncStatus.textContent!==label;els.syncStatus.textContent=label;els.syncStatus.classList.toggle('is-empty',!label);if(label)els.syncStatus.dataset.state=label.toLowerCase().replace(/\s+/g,'-');else delete els.syncStatus.dataset.state;const heartbeatAge=state.lastHeartbeatAt?`${Math.round((Date.now()-state.lastHeartbeatAt)/1000)}s ago`:'n/a';els.syncStatus.title=label?`Users: ${state.currentUsers} | Role: ${state.isLeader?'leader':'follower'} | Partner ready: ${state.isPartnerReady?'yes':'no'} | Latency: ${state.latencyMs??'n/a'}ms | Last heartbeat: ${heartbeatAge}`:'';if(changed&&label)pulseElement(els.syncStatus);updateDiagnostics();};
const updateSyncHealth=()=>{clearInterval(state.healthTimer);state.healthTimer=null;if(!state.hasJoined)return;state.healthTimer=window.setInterval(()=>{if(!socket.connected||state.isLeader||state.currentUsers<2||els.video.paused||state.isScrubbing)return;const age=Date.now()-state.lastHeartbeatAt;if(state.lastHeartbeatAt===0||age>HEARTBEAT_GRACE_MS)requestLiveSync('heartbeat-timeout',{silent:true});},2000);};
const diagnosticsText=()=>formatDiagnosticsText({events:state.diagnosticEvents,presenceLabel:state.presenceLabel,isLeader:state.isLeader,currentUsers:state.currentUsers,latencyMs:state.latencyMs,lastDriftMs:state.lastDriftMs,lastHeartbeatAt:state.lastHeartbeatAt,socketConnected:socket.connected,connection:state.capabilities.connection,profile:state.capabilities.profile,screen:state.capabilities.screen,browser:state.capabilities.browser,platform:state.capabilities.platform,playbackMode:currentPlaybackMode(),videoFile,roomCode:state.roomCode});
const updateDiagnostics=()=>{if(els.roomCode)els.roomCode.textContent=state.roomCode||'------';renderPresence();if(els.diagnosticsRole)els.diagnosticsRole.textContent=state.isLeader?'Leader':'Follower';if(els.diagnosticsUsers)els.diagnosticsUsers.textContent=String(state.currentUsers);if(els.diagnosticsLatency)els.diagnosticsLatency.textContent=state.latencyMs==null?'n/a':`${state.latencyMs}ms`;if(els.diagnosticsDrift)els.diagnosticsDrift.textContent=state.lastDriftMs==null?'n/a':`${state.lastDriftMs}ms`;if(els.diagnosticsHeartbeat)els.diagnosticsHeartbeat.textContent=state.lastHeartbeatAt?`${Math.round((Date.now()-state.lastHeartbeatAt)/1000)}s ago`:'n/a';if(els.diagnosticsConnection)els.diagnosticsConnection.textContent=`${socket.connected?'Connected':'Disconnected'} / ${state.capabilities.connection}`;if(els.diagnosticsDevice)els.diagnosticsDevice.textContent=`${state.capabilities.profile} (${state.capabilities.screen})`;if(els.diagnosticsBrowser)els.diagnosticsBrowser.textContent=state.capabilities.browser;updatePipButton();};
const copyText=async(value,successMessage)=>{try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);else{const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();document.execCommand('copy');input.remove();}status(successMessage,1500);}catch(error){console.error('[COPY]',error);status('Unable to copy to clipboard',2500);}};
const applyResolvedRoomContext=(data={},source='unknown')=>{
const nextVideoFile=typeof data.videoFile==='string'&&data.videoFile.trim()?data.videoFile.trim():null;
const nextRoomCode=typeof data.roomCode==='string'&&data.roomCode.trim()?data.roomCode.trim().toUpperCase():state.roomCode;
if(nextVideoFile)videoFile=nextVideoFile;
if(nextRoomCode)state.roomCode=nextRoomCode;
if(state.roomCode)state.shareUrl=absolutePlayerUrl(videoFile,state.roomCode);
if(nextVideoFile)recordPlaybackEvent('room-context',`${source}:${nextRoomCode||'direct'}`);
updateDiagnostics();
renderJoinOverlay();
};
const waitForResolvedRoomContext=timeoutMs=>new Promise((resolve,reject)=>{
if(videoFile&&state.roomCode){
resolve({videoFile,roomCode:state.roomCode});
return;
}
const timeoutId=window.setTimeout(()=>{
window.removeEventListener('tv:room-context-ready',onReady);
reject(new Error('Room setup timed out.'));
},timeoutMs);
const onReady=event=>{
window.clearTimeout(timeoutId);
window.removeEventListener('tv:room-context-ready',onReady);
resolve(event.detail||{videoFile,roomCode:state.roomCode});
};
window.addEventListener('tv:room-context-ready',onReady,{once:true});
});
const notifyRoomContextReady=(detail={})=>window.dispatchEvent(new CustomEvent('tv:room-context-ready',{detail:{videoFile,roomCode:state.roomCode,...detail}}));
const syncRoomUrl=()=>{
const next=new URL(window.location.href);
if(videoFile)next.searchParams.set('video',videoFile);
if(state.roomCode){
next.searchParams.set('room',state.roomCode);
state.shareUrl=absolutePlayerUrl(videoFile,state.roomCode);
}else next.searchParams.delete('room');
try{
window.history.replaceState({},document.title,`${next.pathname}?${next.searchParams.toString()}`);
}catch(error){
console.debug('[ROOM_URL]',error?.message||error);
}
updateDiagnostics();
renderJoinOverlay();
};
const syncPlaybackModeUi=()=>{if(els.playbackMode)els.playbackMode.value=currentPlaybackMode();renderSettingsSummaries();};
const applyCapabilityDefaults=()=>{const subtitleStyle=loadSavedSubtitleStyle();applySubtitleStyle(subtitleStyle);syncPlaybackModeUi();};
const refreshCapabilities=()=>{state.capabilities=detectCapabilities();applyCapabilityDefaults();updateDiagnostics();};
const maybeRecoverFromStartupBuffer=reason=>{if(state.bufferRecoveryDone||currentPlaybackMode()!=='original'||!mobile()||!state.hasJoined||state.currentUsers<2)return;const now=Date.now();state.bufferIssueCount=(now-state.lastBufferIssueAt)<=5000?state.bufferIssueCount+1:1;state.lastBufferIssueAt=now;const aggressiveRecovery=state.sessionStarted&&currentTime()<12;const threshold=aggressiveRecovery?1:2;if(state.bufferIssueCount<threshold)return;state.bufferRecoveryDone=true;trackPlayback('startup-buffer-fallback',reason);setPlaybackModeState('data-saver');void loadSource({time:currentTime(),resume:!els.video.paused,reason:'startup-buffer-fallback'}).then(()=>{status('Switched this device to Data Save Mode for a steadier start',3200);requestFollowerLobbySync('startup-buffer-fallback',{force:true});}).catch(error=>{console.error('[STARTUP_BUFFER_FALLBACK]',error);state.bufferRecoveryDone=false;});};
const fetchJsonWithTimeout=async(url,options={},timeoutMs=4500)=>{
const timeout=new Promise((_,reject)=>window.setTimeout(()=>reject(new Error('Request timed out')),timeoutMs));
const response=await Promise.race([fetch(url,options),timeout]);
return response;
};
const ensureRoomContext=async()=>{
if(state.roomCode){
traceStartupStep(`room:url ${state.roomCode}`);
applyResolvedRoomContext({videoFile,roomCode:state.roomCode},'url');
presence('Preparing room...');
syncRoomUrl();
if(!socket.connected)socket.connect();
const roomFetch=fetchJsonWithTimeout(`/api/rooms/${encodeURIComponent(state.roomCode)}`,{},4200)
  .then(async response=>{
    if(!response.ok)throw new Error('The invite link is invalid or expired.');
    const data=await response.json();
    applyResolvedRoomContext(data,'api');
    syncRoomUrl();
    notifyRoomContextReady(data);
    traceStartupStep(`room:api ${data.roomCode||state.roomCode}`);
    return data;
  })
  .catch(error=>{
    console.warn('[ROOM_CONTEXT_API]',error?.message||error);
    traceStartupStep(`room:fallback ${error.message||'timeout'}`);
    return null;
  });
if(videoFile){
  void roomFetch;
  presence('Waiting for partner');
  return;
}
const resolved=await Promise.race([roomFetch.then(data=>data||waitForResolvedRoomContext(5200)),waitForResolvedRoomContext(5200)]);
if(!resolved?.videoFile){
  throw new Error('Unable to load the shared video for this room.');
}
applyResolvedRoomContext(resolved,'resolved');
presence('Waiting for partner');
syncRoomUrl();
traceStartupStep(`room:resolved ${resolved.roomCode||state.roomCode}`);
return;
}
const response=await fetchJsonWithTimeout('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoFile})},4200);
if(!response.ok)throw new Error('Unable to create a shareable room.');
const data=await response.json();
applyResolvedRoomContext(data,'create');
presence('Waiting for partner');
syncRoomUrl();
notifyRoomContextReady(data);
if(!socket.connected)socket.connect();
traceStartupStep(`room:create ${data.roomCode||state.roomCode}`);
};
const updateEpisodeButtons=()=>{els.next.disabled=!state.nextAvailable;els.prev.disabled=!state.prevAvailable;els.next.title=state.nextAvailable?'Next Episode':'No next episode available';els.prev.title=state.prevAvailable?'Previous Episode':'No previous episode available';};
const goToVideo=(targetVideo,{autoplay=true}={})=>{if(!targetVideo)return;const next=new URL('/player.html',window.location.origin);next.searchParams.set('video',targetVideo);if(state.roomCode)next.searchParams.set('room',state.roomCode);if(autoplay)next.searchParams.set('autoplay','true');window.location.href=`${next.pathname}?${next.searchParams.toString()}`;};
const clearNextEpisodeCountdown=()=>{clearInterval(state.activeCountdownTimer);state.activeCountdownTimer=null;state.activeCountdownVideo=null;els.countdown.style.display='none';};
const preloadEpisode=async(targetVideo)=>{if(!targetVideo||state.preloadedVideos.has(targetVideo))return;state.preloadedVideos.add(targetVideo);try{await Promise.allSettled([fetch(`/api/video-info?video=${encodeURIComponent(targetVideo)}`),fetch(`/api/subtitles?video=${encodeURIComponent(targetVideo)}`)]);}catch(error){console.error('[PRELOAD]',error);}};
const startNextEpisodeCountdown=(targetVideo,countdownSeconds=8)=>{if(!targetVideo)return;clearNextEpisodeCountdown();state.activeCountdownVideo=targetVideo;let seconds=Math.max(1,Number(countdownSeconds)||8);els.countdownTitle.textContent=prettyEpisodeName(targetVideo.split('/').pop());els.countdownSeconds.textContent=String(seconds);els.countdown.style.display='flex';state.activeCountdownTimer=window.setInterval(()=>{seconds-=1;if(seconds<=0){clearNextEpisodeCountdown();if(state.hasJoined)socket.emit('confirmNextEpisodeCountdown',{video:targetVideo});else goToVideo(targetVideo);return;}els.countdownSeconds.textContent=String(seconds);},1000);};
const sourceFor=time=>{const base=`/videos/${encodePath(videoFile)}`;const mode=currentPlaybackMode();const q=new URLSearchParams(),t=Math.max(0,Number(time)||0),quality=effectiveQuality();if(t>0)q.set('t',String(t));if(mode!=='original')q.set('mode',mode);if(quality!=='auto')q.set('quality',quality);if(mode!=='original'&&state.selectedAudioTrackIndex!==null)q.set('audio',String(state.selectedAudioTrackIndex));const qs=q.toString();return qs?`${base}?${qs}`:base;};
const promptPlay=()=>{state.pendingPrompt='play';els.prompt.querySelector('h1').textContent='Playback is ready.';els.prompt.querySelector('p').textContent='Tap anywhere to finish setup.';els.prompt.classList.remove('is-visible');els.prompt.style.display='flex';if(!prefersReducedMotion){void els.prompt.offsetWidth;els.prompt.classList.add('is-visible');}status('Tap anywhere to finish setup',0,true);};
const restoreAudiblePlayback=()=>{if(state.userMuted)return;if(els.video.volume===0){els.video.volume=1;els.volumeBar.value='1';}els.video.defaultMuted=false;els.video.muted=false;updateVolume();};
const waitForOpeningWarmup=async()=>{
const startedAt=Date.now();
const timeoutMs=mobile()?(state.capabilities.profile==='ios-compat'?2200:1700):1200;
const progressThreshold=mobile()?0.18:0.1;
const minimumBufferedAhead=Math.max(0.2,openingSecondsTargetBuffer()*0.6);
const initialTime=els.video.currentTime||0;
while((Date.now()-startedAt)<timeoutMs){
if(openingSecondsReady()||bufferedAhead()>=minimumBufferedAhead)return true;
if((els.video.currentTime||0)-initialTime>=progressThreshold)return true;
if(els.video.error)throw els.video.error;
await wait(80);
}
return openingSecondsReady()||bufferedAhead()>=minimumBufferedAhead;
};
function minimalPrepareReady(){
const hasSettledSource=state.sourceReady||((Boolean(els.video.currentSrc||els.video.src)||els.video.networkState>0)&&state.sourceLoadingCount===0);
if(els.video.error){
if(!(iosCompat()&&currentPlaybackMode()==='data-saver'&&hasSettledSource))return false;
}
if(state.sourceReady)return true;
if(bufferedAhead()>=0.08)return true;
if(els.video.readyState>=READY)return true;
if(iosCompat())return els.video.readyState>=1||state.viewingPrimed||hasSettledSource;
return els.video.readyState>=1;
}
const primePlaybackFromGesture=async({warmupMs=260,allowDataSaverFallback=true}={})=>{
if(state.mediaPrimed&&openingSecondsReady())return true;
try{
const previousTime=currentTime();
const localTime=Math.max(0,state.seekOffset>0?previousTime-state.seekOffset:previousTime);
const wasMuted=els.video.muted;
els.video.preload='auto';
els.video.defaultMuted=true;
els.video.muted=true;
await els.video.play();
if(warmupMs>0)await wait(warmupMs);
const warmed=await waitForOpeningWarmup();
els.video.pause();
els.video.currentTime=localTime;
els.video.muted=wasMuted;
if(!state.userMuted)restoreAudiblePlayback();
const prepared=warmed||minimalPrepareReady();
if(!warmed&&prepared&&iosCompat())traceStartupStep('prepare:partial-ready');
state.mediaPrimed=Boolean(prepared||state.mediaPrimed);
state.openingWarmupReady=Boolean(warmed);
updatePlayPause();
updateVolume();
syncUi(previousTime);
return state.mediaPrimed;
}catch(error){
console.debug('[PLAY_PRIME]',error?.message||error);
traceStartupStep(`prepare:play-error ${error?.name||'unknown'}`);
if(iosCompat()){
const prepared=minimalPrepareReady();
if(prepared){
traceStartupStep('prepare:ios-soft-ready');
state.mediaPrimed=true;
state.openingWarmupReady=false;
updatePlayPause();
updateVolume();
syncUi(currentTime());
return true;
}
}
if(allowDataSaverFallback&&mobile()&&currentPlaybackMode()==='original'){
try{
trackPlayback('prepare-data-saver-fallback',error?.message||'warmup');
setPlaybackModeState('data-saver');
await loadSource({time:currentTime(),resume:false,reason:'prepare-fallback'});
return primePlaybackFromGesture({warmupMs:420,allowDataSaverFallback:false});
}catch(fallbackError){
console.debug('[PLAY_PRIME_FALLBACK]',fallbackError?.message||fallbackError);
}
}
return false;
}
};
const ensureLobbyPrepared=async()=>{
if(state.lobbyPreparing||state.lobbyPrepared)return state.lobbyPrepared;
state.lobbyPreparing=true;
traceStartupStep('prepare:start');
emitLobbyReadyState();
renderJoinOverlay();
els.playerContainer.style.display='block';
restoreAudiblePlayback();
if(state.sourceLoadingCount>0){
traceStartupStep('prepare:wait-source');
await waitForSourceLoadsToSettle();
}
let viewingReady=false;
if(mobile()&&state.currentUsers>1&&!iosCompat()){
viewingReady=await requestLandscapeViewing({includeOverlay:true});
if(!viewingReady){
traceStartupStep('prepare:landscape-blocked');
state.lobbyPreparing=false;
emitLobbyReadyState();
renderJoinOverlay();
return false;
}
}
state.viewingPrimed=viewingReady||state.viewingPrimed;
let prepared=await primePlaybackFromGesture({warmupMs:currentPlaybackMode()==='data-saver'?420:260});
if(!prepared&&iosCompat()){
prepared=minimalPrepareReady();
if(prepared){
state.mediaPrimed=true;
traceStartupStep('prepare:ios-soft-ready');
}
}
state.lobbyPreparing=false;
state.lobbyPrepared=prepared;
if(prepared&&!mobile())state.preferDesktopFullscreen=true;
emitLobbyReadyState();
if(!prepared){
traceStartupStep('prepare:failed');
status('Playback could not be prepared yet. Try once more.',2600);
renderJoinOverlay();
return false;
}
traceStartupStep('prepare:ready');
if(!socket.connected&&!state.hasJoined)socket.connect();
if(state.pendingBootstrapSnapshot){
await applyBootstrapSnapshot(state.pendingBootstrapSnapshot);
}else requestFollowerLobbySync('prepare-finished',{force:true});
renderJoinOverlay();
return true;
};
const tryPlay=async(showPrompt=false,label=null,{timeoutMs=1800,context='play'}={})=>{
restoreAudiblePlayback();
const baselineTime=currentTime();
try{
const startWait=waitForPlaybackStart(timeoutMs,baselineTime);
const playPromise=els.video.play();
const playOutcome=await Promise.race([
Promise.resolve(playPromise).then(()=>({ ok:true })).catch(error=>({ error })),
wait(timeoutMs).then(()=>({ pending:true }))
]);
if(playOutcome?.error){
const error=playOutcome.error;
if(error?.name==='NotAllowedError'&&showPrompt){
promptPlay();
return false;
}
throw error;
}
const started=await startWait;
if(started||!els.video.paused||currentTime()>baselineTime+0.04){
restoreAudiblePlayback();
if(label)status(label);
return true;
}
console.debug('[PLAY_TIMEOUT]',context,timeoutMs,playOutcome?.pending?'play-promise-pending':'no-progress');
return false;
}catch(error){
if(error?.name==='NotAllowedError'&&showPrompt){
promptPlay();
return false;
}
throw error;
}
};
const loadSource=async({time=state.seekOffset,resume=false,reason='load'}={})=>{
state.sourceLoadingCount+=1;
try{
traceStartupStep(`source:start ${reason}`);
const token=++state.sourceToken;
const targetTime=Math.max(0,Number(time)||0);
const wasPlaying=resume&&!els.video.paused;
const allowMetadataReady=!resume;
state.seekOffset=targetTime;
state.openingWarmupReady=false;
state.sourceReady=false;
setReady(false,`${reason}-start`);
const nextSrc=sourceFor(targetTime),nextAbs=new URL(nextSrc,window.location.origin).href,currentAbs=els.video.currentSrc||els.video.src;
await new Promise((resolve,reject)=>{
let done=false;
let sawMetadata=false;
const timeoutId=window.setTimeout(()=>{
if(sawMetadata||els.video.readyState>=1){
finish(resolve);
return;
}
finish(()=>reject(new Error('Video load timed out')));
},9000);
const clean=()=>{
window.clearTimeout(timeoutId);
els.video.removeEventListener('loadedmetadata',metadataLoaded);
els.video.removeEventListener('loadeddata',loaded);
els.video.removeEventListener('canplay',loaded);
els.video.removeEventListener('error',failed);
};
const finish=cb=>{
if(done||token!==state.sourceToken)return;
done=true;
clean();
cb();
};
const metadataLoaded=()=>{
sawMetadata=true;
if(allowMetadataReady||els.video.readyState>=READY)finish(resolve);
};
const loaded=()=>finish(resolve);
const failed=()=>finish(()=>reject(els.video.error||new Error('Video failed to load')));
els.video.addEventListener('loadedmetadata',metadataLoaded);
els.video.addEventListener('loadeddata',loaded);
els.video.addEventListener('canplay',loaded);
els.video.addEventListener('error',failed);
els.video.preload=resume?'auto':'metadata';
if(currentAbs!==nextAbs)els.video.src=nextSrc;
restoreAudiblePlayback();
els.video.load();
});
setReady(els.video.readyState>=READY,`${reason}-ready`);
state.sourceReady=true;
trackPlayback('source-ready',reason);
traceStartupStep(`source:ready ${reason}`);
restoreAudiblePlayback();
syncUi();
if(wasPlaying)await tryPlay(true);
}finally{
state.sourceLoadingCount=Math.max(0,state.sourceLoadingCount-1);
}
};
const syncTo=async(target,{threshold=SEEK_DRIFT,resume=!els.video.paused,reason='sync'}={})=>{const safe=Math.max(0,Number(target)||0),driftMs=Math.round(Math.abs(currentTime()-safe)*1000);state.lastDriftMs=driftMs;updateDiagnostics();if(Math.abs(currentTime()-safe)<=threshold)return driftMs;if(!directPlaybackMode()){await loadSource({time:safe,resume,reason});return driftMs;}els.video.currentTime=safe;state.seekOffset=0;syncUi(safe);return driftMs;};
const seekTo=async(target,broadcast=true)=>{const total=duration();const boundedMax=total>0?total:Number.POSITIVE_INFINITY;const safe=Math.max(0,Math.min(boundedMax,Number(target)||0));const seekId=broadcast&&state.hasJoined?createSeekId():null;registerSeekWindow(seekId,{allowFallback:Boolean(seekId&&state.hasJoined&&!state.isLeader&&state.currentUsers>1)});recordPlaybackEvent('seek-commit',`${Math.round(safe)}s`,{seekId,source:'local-seek',playbackMode:currentPlaybackMode(),driftMs:0});if(!directPlaybackMode())await loadSource({time:safe,resume:!els.video.paused,reason:'seek'});else{state.seekOffset=0;els.video.currentTime=safe;syncUi(safe);}if(broadcast&&state.hasJoined)socket.emit('seek',{seekId,time:safe,timestamp:Date.now()});if(state.hasJoined&&state.currentUsers>1&&state.isLeader)scheduleLeaderSeekSync('local',seekId);};
const enterPseudoFullscreen=()=>{state.pseudoFullscreen=true;document.body.classList.add('fullscreen-active','pseudo-fullscreen');els.videoWrapper.classList.add('pseudo-fullscreen');syncMobileLayout();showUi();return true;};
const exitPseudoFullscreen=()=>{state.pseudoFullscreen=false;document.body.classList.remove('pseudo-fullscreen');syncMobileLayout();showUi();};
const requestFullscreenOnElement=async(element=els.videoWrapper,{silent=false,preferLandscape=false}={})=>{
if(!element)return false;
if(fullscreenActive())return true;
const iosLandscapeFallback=()=>Boolean(iosCompat()&&mobile()&&(!preferLandscape||window.matchMedia('(orientation: landscape)').matches)&&enterPseudoFullscreen());
const req=element.requestFullscreen||element.webkitRequestFullscreen||element.mozRequestFullScreen||element.msRequestFullscreen;
if(!req){
if(mobile())return iosLandscapeFallback();
return enterPseudoFullscreen();
}
try{
const result=req.call(element);
if(result&&typeof result.then==='function')await result;
if(preferLandscape)await lockLandscapeOrientation();
return true;
}catch(error){
if(!silent)console.debug('[FULLSCREEN]',error);
if(mobile())return iosLandscapeFallback();
return enterPseudoFullscreen();
}};
const requestPlayerFullscreen=(options={},element=els.videoWrapper)=>requestFullscreenOnElement(element,options);
const toggleFullscreen=()=>{if(state.pseudoFullscreen){exitPseudoFullscreen();return;}if(els.video?.webkitDisplayingFullscreen&&typeof els.video.webkitExitFullscreen==='function'){els.video.webkitExitFullscreen();return;}if(!nativeFullscreenActive()){void requestPlayerFullscreen();return;}const exit=document.exitFullscreen||document.webkitExitFullscreen||document.mozCancelFullScreen||document.msExitFullscreen;if(exit)exit.call(document);};
const pipAvailable=()=>Boolean(typeof els.video?.requestPictureInPicture==='function'&&document.pictureInPictureEnabled!==false&&!els.video.disablePictureInPicture);
const pipSupported=()=>Boolean(els.pipButton&&pipAvailable());
const updatePipButton=()=>{if(!els.pipButton)return;if(!pipSupported()){els.pipButton.style.display='none';return;}const active=document.pictureInPictureElement===els.video;els.pipButton.style.display='flex';els.pipButton.setAttribute('aria-pressed',String(active));els.pipButton.title=active?'Exit Picture-in-Picture':'Open mini-player';};
const togglePip=async()=>{if(!pipSupported()){status('Mini-player is not available on this device',1800);return;}try{if(document.pictureInPictureElement===els.video){await document.exitPictureInPicture();status('Mini-player closed',1400);}else{await els.video.requestPictureInPicture();status('Mini-player opened',1400);}}catch(error){console.error('[PIP]',error);trackPlayback('pip-error',error.message||'unknown');status('Unable to open mini-player',2200);}finally{updatePipButton();}};
const portraitViewingBlocked=()=>{
const portraitOnly=mobile()&&window.matchMedia('(max-width: 600px)').matches&&!window.matchMedia('(orientation: landscape)').matches&&els.joinOverlay?.style.display==='none'&&document.pictureInPictureElement!==els.video;
if(!portraitOnly)return false;
if(iosCompat())return state.pseudoFullscreen||!fullscreenActive();
return !fullscreenActive();
};
updatePortraitGate=()=>{const active=portraitViewingBlocked();const changed=state.portraitGateActive!==active;state.portraitGateActive=active;document.body.classList.toggle('portrait-player-gate',active);if(els.portraitGate){els.portraitGate.hidden=!active;els.portraitGate.setAttribute('aria-hidden',String(!active));}if(els.portraitGateTitle)els.portraitGateTitle.textContent=prettyEpisodeName(videoFile.split('/').pop()||videoFile);if(active){closeSettingsPanel();if(changed)status('Rotate to landscape to continue watching',2200);}};
requestLandscapeViewing=async({includeOverlay=false,reusePrimed=true,allowIosGestureAttempt=false}={})=>{
storageSet(sessionStorage,'hasInteracted','true');
storageSet(localStorage,interactionKey,'true');
if(reusePrimed&&canReusePrimedViewing()&&landscapeViewingReady()){
updatePortraitGate();
return true;
}
if(iosCompat()){
const alreadyReady=landscapeViewingReady();
if(alreadyReady){
state.viewingPrimed=true;
updatePortraitGate();
return true;
}
if(!includeOverlay&&!allowIosGestureAttempt){
traceStartupStep('viewing:ios-rotate-needed');
updatePortraitGate();
status('Rotate to landscape to start watching',2200);
return false;
}
}
const fullscreenTarget=includeOverlay?document.documentElement:els.videoWrapper;
await requestPlayerFullscreen({silent:true,preferLandscape:true},fullscreenTarget);
updatePortraitGate();
const ready=landscapeViewingReady();
state.viewingPrimed=ready||state.viewingPrimed;
if(!ready)status('Landscape is required to start watching',2200);
return ready;
};
const requestDesktopViewing=async()=>{storageSet(sessionStorage,'hasInteracted','true');storageSet(localStorage,interactionKey,'true');state.preferDesktopFullscreen=true;await primePlaybackFromGesture();return requestPlayerFullscreen({silent:true});};
const ensureDesktopFullscreen=async()=>{if(mobile()||!state.preferDesktopFullscreen||fullscreenActive())return fullscreenActive();return requestPlayerFullscreen({silent:true});};
const returnToEpisodeStartScreen=({broadcast=true,notifyPartner=false,targetTime=currentTime()}={})=>{
state.startingSession=false;
state.sessionStarted=false;
state.viewingPrimed=false;
completeSyncRequest();
closeSettingsPanel();
hideStatus();
if(broadcast&&state.hasJoined){
socket.emit('pause',{time:targetTime,videoFile,timestamp:Date.now()});
socket.emit('returnToLobby',{time:targetTime,videoFile,timestamp:Date.now()});
}else if(!els.video.paused){
els.video.pause();
}
if(notifyPartner)status('Partner returned to the episode start screen',1800);
if(fullscreenActive()){
state.returnToLobbyAfterFullscreenExit=true;
toggleFullscreen();
return;
}
showJoinOverlay();
renderJoinOverlay();
showUi();
};
const applyBootstrapSnapshot=async data=>{
if(data?.videoFile&&data.videoFile!==videoFile)return;
recordPlaybackEvent('bootstrap',data?.paused?'paused':'playing');
state.pendingBootstrapSnapshot=null;
state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;
if(data?.audioTrackIndex!==undefined&&data.audioTrackIndex!==null)await setAudioTrackSelection(data.audioTrackIndex,{broadcast:false,silent:true});
await syncTo(data?.time,{threshold:0.35,resume:!(data?.paused),reason:'bootstrap'});
if(data?.paused){
els.video.pause();
state.sessionStarted=false;
}else{
if(mobile()){
const ready=await requestLandscapeViewing({reusePrimed:true});
if(!ready){
state.sessionStarted=false;
showJoinOverlay();
updatePortraitGate();
completeSyncRequest();
updateSyncStatus();
renderJoinOverlay();
return;
}
}else await ensureDesktopFullscreen();
await tryPlay(true);
state.sessionStarted=true;
hideJoinOverlay({immediate:true});
}
if(data?.subtitleOffsetMs!==undefined)setSubtitleOffset(data.subtitleOffsetMs,{broadcast:false,notify:false});
if(data?.subtitleUrl!==undefined){
try{await setSubtitle(data.subtitleUrl||null,{silent:true});}catch(error){console.error('[BOOTSTRAP SUBTITLES]',error);}
}
completeSyncRequest();
updateSyncStatus();
renderJoinOverlay();
};
const mediaSession=()=>navigator.mediaSession||null;
const setMediaSessionActionHandler=(action,handler)=>{const session=mediaSession();if(!session?.setActionHandler)return;try{session.setActionHandler(action,handler);}catch(error){console.debug(`[MEDIA_SESSION] ${action}`,error?.message||error);}};
const syncMediaSessionMetadata=()=>{const session=mediaSession();if(!session||typeof window.MediaMetadata!=='function')return;try{session.metadata=new window.MediaMetadata({title:prettyEpisodeName(videoFile.split('/').pop()||videoFile),artist:'Tvstack',album:state.currentUsers>1?'Watch together session':'Personal watch session',artwork:[{src:'/app-icon.svg',sizes:'512x512',type:'image/svg+xml'}]});}catch(error){console.debug('[MEDIA_SESSION_METADATA]',error?.message||error);}};
const syncMediaSessionPlaybackState=()=>{const session=mediaSession();if(!session)return;try{session.playbackState=els.video.paused?'paused':'playing';}catch(error){console.debug('[MEDIA_SESSION_PLAYBACK]',error?.message||error);}};
const syncMediaSessionPosition=()=>{const session=mediaSession();if(!session?.setPositionState)return;const total=duration();if(!Number.isFinite(total)||total<=0)return;try{session.setPositionState({duration:total,playbackRate:els.video.playbackRate||1,position:Math.min(total,Math.max(0,currentTime()))});}catch(error){console.debug('[MEDIA_SESSION_POSITION]',error?.message||error);}};
const syncMediaSession=()=>{syncMediaSessionMetadata();syncMediaSessionPlaybackState();syncMediaSessionPosition();};
const configureMediaSession=()=>{if(!mediaSession())return;syncMediaSessionMetadata();setMediaSessionActionHandler('play',()=>{if(els.video.paused)requestPlay();});setMediaSessionActionHandler('pause',()=>{if(!els.video.paused)requestPause();});setMediaSessionActionHandler('stop',()=>{if(!els.video.paused)requestPause();});setMediaSessionActionHandler('seekbackward',details=>{void seekTo(currentTime()-(Number(details?.seekOffset)||10));});setMediaSessionActionHandler('seekforward',details=>{void seekTo(currentTime()+(Number(details?.seekOffset)||30));});setMediaSessionActionHandler('seekto',details=>{if(Number.isFinite(details?.seekTime))void seekTo(details.seekTime);});setMediaSessionActionHandler('previoustrack',()=>{if(!state.prevAvailable||!state.prevVideo)return;if(state.hasJoined){socket.emit('requestPreviousVideo',{videoFile});return;}goToVideo(state.prevVideo,{autoplay:true});});setMediaSessionActionHandler('nexttrack',()=>{if(!state.nextAvailable||!state.nextVideo)return;if(state.hasJoined){socket.emit('requestNextVideo',{videoFile});return;}goToVideo(state.nextVideo,{autoplay:true});});setMediaSessionActionHandler('enterpictureinpicture',()=>{if(!pipAvailable()||document.pictureInPictureElement===els.video)return;void els.video.requestPictureInPicture().then(()=>{updatePipButton();}).catch(error=>{console.debug('[MEDIA_SESSION_PIP]',error?.message||error);trackPlayback('pip-error',error?.message||'unknown');});});if(android()&&pipAvailable())els.video.removeAttribute('disablePictureInPicture');syncMediaSession();};
const nativeSubtitleCtor=()=>window.VTTCue||window.TextTrackCue||null;
const supportsNativeSubtitleTrack=()=>Boolean(els.video&&typeof els.video.addTextTrack==='function'&&nativeSubtitleCtor());
const hideNativeSubtitleTracks=()=>{const tracks=els.video?.textTracks;if(!tracks)return;for(const track of Array.from(tracks)){try{track.mode='hidden';}catch(error){console.debug('[NATIVE_SUBTITLES_HIDE]',error?.message||error);}}};
const clearNativeSubtitleTrack=()=>{const track=state.nativeSubtitleTrack;if(!track?.cues)return;try{for(const cue of [...track.cues])track.removeCue(cue);}catch(error){console.debug('[NATIVE_SUBTITLES_CLEAR]',error?.message||error);}};
const updateNativeSubtitleTrackMode=({forceVisible=false}={})=>{hideNativeSubtitleTracks();if(!state.nativeSubtitleTrack)return;const shouldShow=Boolean(state.activeSubtitleUrl)&&state.cues.length>0&&(forceVisible||document.pictureInPictureElement===els.video);state.nativeSubtitleTrack.mode=shouldShow?'showing':'hidden';};
const syncNativeSubtitleTrack=({forceVisible=false}={})=>{if(!supportsNativeSubtitleTrack()){hideNativeSubtitleTracks();return;}const CueCtor=nativeSubtitleCtor();if(!CueCtor){hideNativeSubtitleTracks();return;}const shouldShow=Boolean(state.activeSubtitleUrl)&&state.cues.length>0&&(forceVisible||document.pictureInPictureElement===els.video);if(!state.nativeSubtitleTrack&&!shouldShow){hideNativeSubtitleTracks();return;}const track=state.nativeSubtitleTrack||els.video.addTextTrack('captions','Tvstack PiP Subtitles','en');state.nativeSubtitleTrack=track;clearNativeSubtitleTrack();if(!state.activeSubtitleUrl||state.cues.length===0){updateNativeSubtitleTrackMode({forceVisible});return;}for(const cueData of state.cues){const cueText=String(cueData.text||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'');const cue=new CueCtor(Math.max(0,cueData.start+(state.subtitleOffsetMs/1000)),Math.max(0,cueData.end+(state.subtitleOffsetMs/1000)),cueText);try{cue.snapToLines=false;cue.line=DEFAULT_PIP_SUBTITLE_LINE;cue.position=50;cue.size=80;cue.align='center';cue.lineAlign='center';cue.positionAlign='center';}catch(error){console.debug('[NATIVE_SUBTITLES_CUE]',error?.message||error);}track.addCue(cue);}updateNativeSubtitleTrackMode({forceVisible});if(forceVisible)window.setTimeout(()=>updateNativeSubtitleTrackMode({forceVisible:true}),40);};
const renderSubtitle=()=>{const activeTime=currentTime()+(state.subtitleOffsetMs/1000),cue=state.cues.find(item=>activeTime>=item.start&&activeTime<item.end);if(!cue){els.subtitleContainer.style.visibility='hidden';els.subtitleContainer.innerHTML='';return;}els.subtitleContainer.innerHTML=`<span>${cue.text}</span>`;els.subtitleContainer.style.visibility='visible';};
const updateSubtitleOffset=()=>{els.subtitleOffset.textContent=`${state.subtitleOffsetMs>0?'+':''}${state.subtitleOffsetMs}ms`;els.subtitleOffset.title=state.currentUsers>1?'Synchronized across all viewers':'Local until another viewer joins';renderSettingsSummaries();};
const setSubtitleOffset=(offset,{broadcast=true,notify=true,persist=true}={})=>{state.subtitleOffsetMs=Number.parseInt(offset,10)||0;if(persist){if(state.subtitleOffsetMs===0)storageRemove(localStorage,subtitleOffsetKey());else storageSet(localStorage,subtitleOffsetKey(),String(state.subtitleOffsetMs));}updateSubtitleOffset();renderSubtitle();syncNativeSubtitleTrack();if(broadcast)broadcastSubtitleOffset();if(notify)status(`Subtitle timing: ${state.subtitleOffsetMs>0?'+':''}${state.subtitleOffsetMs}ms`,1500);};
const storeSubtitleSelection=value=>{if(!value){storageRemove(localStorage,subtitleKey());return;}storageSet(localStorage,subtitleKey(),value);};
const broadcastSubtitleSelection=url=>{if(state.hasJoined)socket.emit('subtitleSelectionUpdate',{videoFile,subtitleUrl:url,language:state.availableSubtitles.find(item=>item.url===url)?.lang||'Off',timestamp:Date.now()});};
const broadcastSubtitleOffset=()=>{if(state.hasJoined)socket.emit('subtitleOffsetUpdate',{videoFile,offset:state.subtitleOffsetMs,timestamp:Date.now()});};
const upsertSubtitleTrack=subtitle=>{if(!subtitle?.url)return;const next={lang:subtitle.lang||'English',meta:subtitle.meta||'',source:subtitle.source||'external',url:subtitle.url};state.availableSubtitles=[next,...state.availableSubtitles.filter(item=>item.url!==next.url)];};
const subtitleChoice=()=>{const stored=storageGet(localStorage,subtitleKey());if(stored==='off')return null;if(stored)return stored;const preferred=[['english auto','eng','english','en'],['nederlands','dutch','nld','nl']];for(const names of preferred){const found=state.availableSubtitles.find(item=>names.some(name=>item.lang.toLowerCase().includes(name)||item.lang.toLowerCase()===name));if(found)return found.url;}return state.availableSubtitles[0]?.url||null;};
const loadSubtitleFile=async url=>{if(!url){state.cues=[];els.subtitleContainer.style.visibility='hidden';syncNativeSubtitleTrack();return;}const response=await fetch(url);if(!response.ok)throw new Error(`Failed to load subtitle: ${response.status}`);const text=await response.text();state.cues=(text.startsWith('WEBVTT')||url.endsWith('.vtt'))?parseVtt(text):parseSrt(text);syncNativeSubtitleTrack();};
const setSubtitle=async(url,{broadcast=false,silent=false}={})=>{const previous=state.activeSubtitleUrl;state.activeSubtitleUrl=url;storeSubtitleSelection(url||'off');renderSubtitleButtons();if(broadcast)broadcastSubtitleSelection(url);try{await loadSubtitleFile(url);renderSubtitle();}catch(error){state.activeSubtitleUrl=previous;storeSubtitleSelection(previous||'off');renderSubtitleButtons();throw error;}if(!silent)status(url?'Subtitle updated':'Subtitles turned off',1500);};
const createSubtitleButton=({title,meta='',pill='',active=false,onClick})=>{const button=document.createElement('button');if(active)button.classList.add('active');const copy=document.createElement('span');copy.className='subtitle-button-copy';const titleNode=document.createElement('span');titleNode.className='subtitle-button-title';titleNode.textContent=title;copy.appendChild(titleNode);if(meta){const metaNode=document.createElement('span');metaNode.className='subtitle-button-meta';metaNode.textContent=meta;copy.appendChild(metaNode);}button.appendChild(copy);if(pill){const pillNode=document.createElement('span');pillNode.className='subtitle-button-pill';pillNode.textContent=pill;button.appendChild(pillNode);}button.onclick=onClick;return button;};
const autoSubtitleMeta=()=>{switch(state.autoSubtitleStatus){case'loading':return{title:'Finding English subtitles...',meta:'Searching and downloading the best episode match.',pill:'...'};case'ready':return{title:'English subtitle ready',meta:'Downloaded match for this episode.',pill:'Auto'};case'error':return{title:'Auto English subtitle',meta:'Could not load automatically. You can still pick local tracks below.',pill:'Retry'};default:return{title:'Auto English subtitle',meta:'Search, download and load the best matching subtitle for this episode.',pill:'Auto'};}};
const autoLoadEnglishSubtitle=async()=>{if(state.autoSubtitleStatus==='loading'){return;}state.autoSubtitleStatus='loading';renderSubtitleButtons();try{const response=await fetch('/api/subtitles/auto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({video:videoFile})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`Automatic subtitle lookup failed (${response.status})`);if(!data?.subtitle?.url)throw new Error('No subtitle was returned');upsertSubtitleTrack(data.subtitle);state.autoSubtitleStatus='ready';renderSubtitleButtons();closeSettingsPanel();window.setTimeout(()=>{void setSubtitle(data.subtitle.url,{broadcast:true}).then(()=>status('English subtitles loaded',1800));},0);}catch(error){state.autoSubtitleStatus='error';renderSubtitleButtons();console.error('[AUTO_SUBTITLES]',error);status(error.message||'Automatic subtitle lookup failed',3500);}};
const renderSubtitleButtons=()=>{els.subtitleButtons.innerHTML='';els.subtitlesGroup.style.display='block';const autoMeta=autoSubtitleMeta();els.subtitleButtons.appendChild(createSubtitleButton({title:autoMeta.title,meta:autoMeta.meta,pill:autoMeta.pill,active:Boolean(state.activeSubtitleUrl&&state.availableSubtitles.some(item=>item.url===state.activeSubtitleUrl&&item.source==='auto')),onClick:()=>{void autoLoadEnglishSubtitle();}}));const off=createSubtitleButton({title:'Subtitles off',meta:'Turn subtitles off for everyone in the session.',pill:'Off',active:!state.activeSubtitleUrl,onClick:()=>{window.setTimeout(()=>{void setSubtitle(null,{broadcast:true});},0);}});els.subtitleButtons.appendChild(off);if(state.availableSubtitles.length===0){const msg=document.createElement('div');msg.className='subtitle-empty-state';msg.textContent='No local or embedded subtitles found yet.';els.subtitleButtons.appendChild(msg);}for(const sub of state.availableSubtitles){const button=createSubtitleButton({title:sub.lang,meta:sub.meta||('source'in sub&&sub.source==='auto'?'Downloaded for this episode':'Embedded or local subtitle track'),pill:sub.source==='auto'?'Auto':'Track',active:sub.url===state.activeSubtitleUrl,onClick:()=>{window.setTimeout(()=>{void setSubtitle(sub.url,{broadcast:true});},0);}});els.subtitleButtons.appendChild(button);}els.subtitleOffsetControls.style.display=state.activeSubtitleUrl?'block':'none';renderSettingsSummaries();};
const setUserCount=count=>{const changed=state.currentUsers!==count;state.currentUsers=count;els.userCount.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" width="16" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg> <span>'+count+'</span>';if(count>1)closeInviteMenu();syncMediaSessionMetadata();if(changed)pulseElement(els.userCount);updateSubtitleOffset();updateSyncStatus();renderSettingsSummaries();renderJoinOverlay();showUi();};
const createBreadcrumb=pathValue=>{els.breadcrumb.innerHTML='';const home=document.createElement('a');home.href='/';home.textContent='Home';els.breadcrumb.appendChild(home);const parts=pathValue.split('/');let parentHref='/',cum='';parts.forEach((part,index)=>{const sep=document.createElement('span');sep.className='separator';sep.textContent=' > ';els.breadcrumb.appendChild(sep);if(index<parts.length-1){cum=cum?`${cum}/${part}`:part;const link=document.createElement('a');link.href=`/?path=${encodeURIComponent(cum)}`;link.textContent=part;els.breadcrumb.appendChild(link);parentHref=link.href;return;}const current=document.createElement('span');current.className='current-item';current.textContent=prettyEpisodeName(part);els.breadcrumb.appendChild(current);});state.parentHref=parentHref;els.back.onclick=event=>{event.preventDefault();if(fullscreenActive()){returnToEpisodeStartScreen();return;}saveProgress();window.setTimeout(()=>{window.location.href=state.parentHref;},150);};};
const applyAccessibilityLabels=()=>{els.playPause.setAttribute('aria-label','Play or pause');els.rewind.setAttribute('aria-label','Rewind 10 seconds');els.forward.setAttribute('aria-label','Forward 30 seconds');els.prev.setAttribute('aria-label','Previous episode');els.next.setAttribute('aria-label','Next episode');els.volumeButton.setAttribute('aria-label','Mute or unmute');els.pipButton?.setAttribute('aria-label','Toggle mini-player');els.settingsButton.setAttribute('aria-label','Open player settings');els.fullscreen.setAttribute('aria-label','Toggle fullscreen');els.joinButton.setAttribute('aria-label','Prepare or start the synchronized session');els.joinCopyButton?.setAttribute('aria-label','Copy invite link');els.presence?.setAttribute('aria-label','Copy invite link for your partner');els.resyncButton?.setAttribute('aria-label','Resync with your partner');els.webcamToggleButton?.setAttribute('aria-label','Share or stop your camera for this room');els.portraitGateRotate?.setAttribute('aria-label','Open landscape viewing mode');els.back?.setAttribute('aria-label','Return to the episode start screen');els.back?.setAttribute('title','Back to episode start');};
const fetchVideoInfo=async()=>{traceStartupStep('video info:request');const response=await fetch(`/api/video-info?video=${encodeURIComponent(videoFile)}`);if(!response.ok)throw new Error(`Failed to load video info (${response.status})`);const data=await response.json();state.duration=Number(data.duration)||0;state.isProblematic=Boolean(data.isProblematic);state.availableAudioTracks=Array.isArray(data.audioTracks)?data.audioTracks:[];state.selectedAudioTrackIndex=defaultAudioTrackIndex();renderAudioTracks();syncPlaybackModeUi();syncUi(0);traceStartupStep('video info:ready');};
const fetchSubtitles=async()=>{try{traceStartupStep('subtitles:request');const response=await fetch(`/api/subtitles?video=${encodeURIComponent(videoFile)}`);if(!response.ok)throw new Error(`Subtitle request failed (${response.status})`);const data=await response.json();state.availableSubtitles=Array.isArray(data.subtitles)?data.subtitles:[];if(state.availableSubtitles.some(item=>item.source==='auto'))state.autoSubtitleStatus='ready';const savedOffset=Number.parseInt(storageGet(localStorage,subtitleOffsetKey())||'0',10);setSubtitleOffset(Number.isFinite(savedOffset)?savedOffset:0,{broadcast:false,notify:false});const chosen=subtitleChoice();if(chosen&&chosen.startsWith('/subtitles/')){upsertSubtitleTrack({lang:'English (Auto)',meta:'Previously downloaded for this episode.',source:'auto',url:chosen});state.autoSubtitleStatus='ready';}if(chosen||storageGet(localStorage,subtitleKey())==='off'){state.activeSubtitleUrl=chosen;renderSubtitleButtons();await setSubtitle(chosen,{silent:true});traceStartupStep('subtitles:ready');return;}renderSubtitleButtons();traceStartupStep('subtitles:ready');}catch(error){state.availableSubtitles=[];renderSubtitleButtons();const savedOffset=Number.parseInt(storageGet(localStorage,subtitleOffsetKey())||'0',10);setSubtitleOffset(Number.isFinite(savedOffset)?savedOffset:0,{broadcast:false,notify:false});console.error('[SUBTITLES]',error);trackPlayback('subtitle-load-failed',error.message||'unknown');status(`Subtitle loading failed: ${error.message}`,4000);traceStartupStep(`subtitles:error ${error.message||'unknown'}`);}};
const requestPlay=()=>{traceStartupStep(`play:request joined=${state.hasJoined?'yes':'no'} users=${state.currentUsers}`);if(state.hasJoined){socket.emit('requestPlay',{time:currentTime(),timestamp:Date.now()});return;}void tryPlay(true);};
const requestPause=()=>{if(state.hasJoined){socket.emit('pause',{time:currentTime(),videoFile,timestamp:Date.now()});return;}els.video.pause();};
const cleanup=()=>{saveProgress();clearInterval(state.progressTimer);clearInterval(state.leaderTimer);clearInterval(state.healthTimer);clearInterval(state.diagnosticsTimer);clearTimeout(state.statusTimer);clearTimeout(state.uiTimer);clearSnapshotRetry();clearNextEpisodeCountdown();clearLobbySync();clearPostSeekSync();clearPendingSeekResync();void webcamController.cleanup();};
const init=async()=>{document.body.classList.add('join-overlay-visible');els.video.controls=false;els.video.preload='metadata';els.video.playsInline=true;els.video.setAttribute('playsinline','true');els.video.setAttribute('webkit-playsinline','true');if(android())els.video.removeAttribute('disablePictureInPicture');ensureInlinePreviewPlayback(els.webcamRemoteVideo);ensureInlinePreviewPlayback(els.webcamLocalVideo);restoreAudiblePlayback();applyAccessibilityLabels();refreshCapabilities();renderWebcamUi({canToggle:false,statusLabel:'Camera sharing is loading...',buttonLabel:'Share Camera',dockVisible:false});renderJoinOverlay();if(state.roomCode)syncRoomUrl();void initializeWebcamController();await ensureRoomContext();if(!videoFile)throw new Error('Unable to resolve the video for this room.');els.videoTitle.textContent=prettyEpisodeName(videoFile.split('/').pop());configureMediaSession();updatePlayPause();updateVolume();updateEpisodeButtons();els.fullscreen.innerHTML=fsEnter;updatePipButton();renderSubtitleButtons();createBreadcrumb(videoFile);updateSyncStatus();clearInterval(state.diagnosticsTimer);state.diagnosticsTimer=window.setInterval(updateDiagnostics,1000);await Promise.all([fetchVideoInfo(),fetchSubtitles()]);await loadSource({time:0,resume:false,reason:'initial'});els.playerContainer.style.display='block';renderJoinOverlay();showUi();if(autoplayRequested()&&(storageGet(localStorage,interactionKey)==='true'||storageGet(sessionStorage,'hasInteracted')==='true')){state.lobbyPrepared=true;state.sessionStarted=true;state.preferDesktopFullscreen=!mobile();restoreAudiblePlayback();if(!mobile())hideJoinOverlay({immediate:true});if(!socket.connected)socket.connect();}};

socket.on('connect',()=>{recordPlaybackEvent('connect',state.roomCode||videoFile||'room');socket.emit('joinRoom',{videoFile,roomCode:state.roomCode});});
socket.on('connect_error',error=>{console.error('[SOCKET]',error);updateSyncStatus();status('Connection lost. Retrying...',2000);});
socket.on('joined',data=>{if(data?.roomCode||data?.videoFile){applyResolvedRoomContext({roomCode:data?.roomCode,videoFile:data?.videoFile},'socket');syncRoomUrl();notifyRoomContextReady(data);}if(Number.isFinite(data?.participantCount)&&data.participantCount>0)setUserCount(data.participantCount);if(typeof data?.isLeader==='boolean')state.isLeader=Boolean(data.isLeader);recordPlaybackEvent('joined',state.roomCode||'direct-room');traceStartupStep(`socket:joined ${state.roomCode||'direct'}`);state.hasJoined=true;webcamController.setJoined(true);webcamController.setLeader(state.isLeader);presence(state.currentUsers>1?'Partner connected':'Waiting for partner');updateSyncStatus();updateSyncHealth();renderJoinOverlay();requestFollowerLobbySync('join-sync',{force:true});if(!openedFromInviteLink&&(state.currentUsers<=1||state.isLeader))socket.emit('getProgress',{videoFile});socket.emit('checkNextVideo',{videoFile});socket.emit('checkPreviousVideo',{videoFile});emitLobbyReadyState({force:true});if(state.subtitleOffsetMs!==0)broadcastSubtitleOffset();if(state.activeSubtitleUrl)broadcastSubtitleSelection(state.activeSubtitleUrl);if(state.selectedAudioTrackIndex!==null)broadcastAudioTrackSelection(state.selectedAudioTrackIndex);clearInterval(state.progressTimer);state.progressTimer=window.setInterval(()=>{if(!els.video.paused)saveProgress();},PROGRESS_MS);updateLeaderSync();if(autoplayRequested()){requestPlay();params.delete('autoplay');const clean=params.toString();window.history.replaceState({},document.title,clean?`${window.location.pathname}?${clean}`:window.location.pathname);}});
socket.on('roomNotFound',()=>{document.body.innerHTML='<div class="status-fullscreen"><h1>Room not found</h1><p>This invite link is invalid or expired.</p><a href="/" class="back-link">Back to Video List</a></div>';});
socket.on('presenceUpdate',data=>{const type=data?.type;switch(type){case'partner_joining':presence('Partner is joining...', {toast:true});break;case'partner_rejoining':presence('Partner is rejoining...', {toast:true});break;case'partner_connected':presence('Partner connected', {toast:true});break;case'partner_reconnected':presence('Partner reconnected', {toast:true});break;default:break;}window.setTimeout(()=>{requestLobbyStateSync();},120);});
socket.on('webcamStateSync',data=>{webcamController.handleWebcamStateSync(data);});
socket.on('partnerCameraState',data=>{webcamController.handlePartnerCameraState(data);if(data?.cameraEnabled)status('Partner camera is live',1500);});
socket.on('webrtcOffer',data=>{void webcamController.handleOffer(data);});
socket.on('webrtcAnswer',data=>{void webcamController.handleAnswer(data);});
socket.on('webrtcIceCandidate',data=>{void webcamController.handleIceCandidate(data);});
socket.on('webrtcHangup',data=>{webcamController.handleHangup(data);});
socket.on('roomFull',()=>{document.body.innerHTML='<div class="status-fullscreen"><h1>Session is Full</h1><p>The max number of users has been reached.</p><a href="/" class="back-link">Back to Video List</a></div>';});
socket.on('roomSyncBootstrap',data=>{enqueue(async()=>{if(data?.videoFile&&data.videoFile!==videoFile)return;if(!matchesActiveSyncRequest(data))return;const deferBootstrap=Boolean(!state.sessionStarted&&state.currentUsers>1&&!state.isLeader&&(!state.lobbyPrepared||!openingSecondsReady()));if(deferBootstrap){state.pendingBootstrapSnapshot=data;recordPlaybackEvent('bootstrap-deferred',`${Math.round(Number(data?.time)||0)}s`,{source:data?.snapshotSource||'bootstrap',playbackMode:currentPlaybackMode()});updateSyncStatus();renderJoinOverlay();return;}await applyBootstrapSnapshot(data);});});
socket.on('loadProgress',data=>{if(openedFromInviteLink&&!state.sessionStarted){traceStartupStep('progress:ignored-invite');return;}if(state.currentUsers>1&&!state.isLeader)return;enqueue(async()=>{const time=Math.max(0,Number(data?.time)||0);if(time>0)await syncTo(time,{threshold:0.25,resume:false,reason:'progress-load'});});});
socket.on('play',data=>{enqueue(async()=>{recordPlaybackEvent('play',`${Math.round(Number(data?.time)||0)}s`);traceStartupStep(`socket:play ${Math.round(Number(data?.time)||0)}s`);state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;state.startingSession=false;completeSyncRequest();hideStatus();if(mobile()){const localInitiator=Boolean(data?.initiator&&data.initiator===socket.id);let ready=false;if(localInitiator&&iosCompat()&&(state.viewingPrimed||landscapeViewingReady())){ready=true;traceStartupStep('socket:play-viewing reuse-initiator');}else ready=await requestLandscapeViewing({reusePrimed:true});traceStartupStep(`socket:play-viewing ${ready?'ready':'blocked'}`);if(!ready){traceStartupStep('socket:play-blocked');state.sessionStarted=false;showJoinOverlay();updatePortraitGate();updateSyncStatus();renderJoinOverlay();return;}}else await ensureDesktopFullscreen();await syncTo(data?.time,{threshold:PLAY_DRIFT,resume:!els.video.paused,reason:'remote-play'});traceStartupStep('socket:play-synced');const started=await tryPlay(true,data?.initiator===socket.id?'You resumed playback':'Playback resumed by partner',{timeoutMs:iosCompat()?1400:2200,context:'socket-play'});if(!started){traceStartupStep('socket:play-timeout');state.sessionStarted=false;showJoinOverlay();updatePortraitGate();updateSyncStatus();renderJoinOverlay();return;}state.sessionStarted=true;traceStartupStep('socket:playing');hideJoinOverlay({immediate:true});updateSyncStatus();renderJoinOverlay();});});
socket.on('pause',data=>{enqueue(async()=>{recordPlaybackEvent('pause',`${Math.round(Number(data?.time)||0)}s`);state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;state.startingSession=false;await syncTo(data?.time,{threshold:SEEK_DRIFT,resume:false,reason:'remote-pause'});els.video.pause();status(data?.initiator===socket.id?'Playback paused':'Playback paused by partner');updateSyncStatus();renderJoinOverlay();});});
socket.on('returnToLobby',data=>{enqueue(async()=>{if(data?.videoFile&&data.videoFile!==videoFile)return;recordPlaybackEvent('return-to-lobby',`${Math.round(Number(data?.time)||0)}s`);state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;await syncTo(data?.time,{threshold:SEEK_DRIFT,resume:false,reason:'remote-return-lobby'});returnToEpisodeStartScreen({broadcast:false,notifyPartner:true,targetTime:Number(data?.time)||currentTime()});});});
socket.on('seek',data=>{enqueue(async()=>{state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;registerSeekWindow(data?.seekId||null);const driftMs=await syncTo(data?.time,{threshold:SEEK_DRIFT,resume:!els.video.paused,reason:'remote-seek'});recordPlaybackEvent('seek',`${Math.round(Number(data?.time)||0)}s`,{seekId:data?.seekId||null,source:'remote-seek',playbackMode:currentPlaybackMode(),driftMs});if(!els.video.paused&&state.sessionStarted){const resumed=await tryPlay(false,null,{timeoutMs:iosCompat()?1200:1800,context:'remote-seek'});if(!resumed&&state.hasJoined&&state.currentUsers>1&&!state.isLeader&&!seekWindowActive()){requestLiveSync('seek-resume',{silent:true,force:true});}}if(state.isLeader)scheduleLeaderSeekSync('remote',data?.seekId||null);status('Position synchronized',1200);updateSyncStatus();});});
socket.on('waitingForPartner',()=>{state.startingSession=true;renderJoinOverlay();status('Waiting for partner to be ready...',0,true);});
socket.on('requestReadyStateUpdate',()=>emitLobbyReadyState({force:true}));
socket.on('readyStateSync',data=>{const clients=Array.isArray(data?.clients)?data.clients:[];traceStartupStep(`room:ready-sync users=${clients.length} pending=${data?.pendingAction||'none'}`);if(clients.length>0&&clients.length!==state.currentUsers)setUserCount(clients.length);const otherClients=clients.filter(client=>client?.id!==socket.id);state.isPartnerReady=otherClients.length===0?true:otherClients.every(client=>Boolean(client?.isReady));if(data?.pendingAction!=='play'&&state.startingSession)state.startingSession=false;updateSyncStatus();renderJoinOverlay();});
socket.on('reconnect',()=>{recordPlaybackEvent('reconnect');presence('Connection restored. Resyncing...', {toast:true});updateSyncStatus();updateSyncHealth();renderJoinOverlay();emitLobbyReadyState({force:true});requestFollowerLobbySync('reconnect',{force:true});});
socket.on('disconnect',()=>{recordPlaybackEvent('disconnect');state.lastHeartbeatAt=0;completeSyncRequest();webcamController.handleDisconnect();presence('Reconnecting...');updateSyncStatus();renderJoinOverlay();});
socket.on('userCountUpdate',({count})=>{traceStartupStep(`room:users ${count}`);const hadPartner=state.currentUsers>1;setUserCount(count);webcamController.setParticipantCount(count);if(count>1){state.isWatchingAlone=false;if(!hadPartner)state.isPartnerReady=false;if(state.isPartnerReady)presence('Partner connected');}else{completeSyncRequest();state.isPartnerReady=true;presence('Waiting for partner');}emitLobbyReadyState({force:true});requestFollowerLobbySync('partner-detected',{force:true});updateLeaderSync();updateSyncHealth();renderJoinOverlay();});
socket.on('leaderStatus',({isLeader})=>{traceStartupStep(`room:leader ${isLeader?'yes':'no'}`);state.isLeader=Boolean(isLeader);webcamController.setLeader(state.isLeader);if(state.isLeader)completeSyncRequest();updateLeaderSync();updateSyncHealth();updateSyncStatus();renderJoinOverlay();requestFollowerLobbySync('leader-update',{force:true});});
socket.on('partnerReadyState',({isReady,timestamp})=>{state.isPartnerReady=Boolean(isReady);state.latencyMs=timestamp?Math.max(0,Date.now()-timestamp):state.latencyMs;updateSyncStatus();renderJoinOverlay();if(!state.isPartnerReady&&state.currentUsers>1){presence('Partner buffering');status('Partner is buffering...',1500);}if(state.isPartnerReady&&state.currentUsers>1){presence('Partner connected');requestFollowerLobbySync('partner-ready',{force:true});}});
socket.on('syncTime',data=>{enqueue(async()=>{if(!state.hasJoined||state.isLeader||state.currentUsers<2||state.isScrubbing)return;state.lastHeartbeatAt=Date.now();state.latencyMs=data?.timestamp?Math.max(0,Date.now()-data.timestamp):state.latencyMs;completeSyncRequest();updateSyncStatus();if(data?.paused)return;const overlayVisible=els.joinOverlay?.style.display!=='none';if((!state.sessionStarted||overlayVisible)&&state.lobbyPrepared){traceStartupStep(overlayVisible?'heartbeat:overlay-recover':'heartbeat:late-start');if(mobile()){const ready=await requestLandscapeViewing({reusePrimed:true});traceStartupStep(`heartbeat:viewing ${ready?'ready':'blocked'}`);if(!ready){showJoinOverlay();updatePortraitGate();renderJoinOverlay();return;}}else await ensureDesktopFullscreen();await syncTo(data?.time,{threshold:HEARTBEAT_DRIFT,resume:true,reason:'leader-heartbeat'});traceStartupStep('heartbeat:synced');const started=await tryPlay(true,'Playback resumed by partner',{timeoutMs:iosCompat()?1400:2200,context:'leader-heartbeat'});if(!started){traceStartupStep('heartbeat:play-timeout');state.sessionStarted=false;showJoinOverlay();updatePortraitGate();updateSyncStatus();renderJoinOverlay();return;}state.sessionStarted=true;hideJoinOverlay({immediate:true});updateSyncStatus();renderJoinOverlay();return;}await syncTo(data?.time,{threshold:HEARTBEAT_DRIFT,resume:true,reason:'leader-heartbeat'});});});
socket.on('requestSyncSnapshot',({targetSocketId,requestId}={})=>{if(!state.hasJoined||!state.isLeader)return;socket.emit('syncSnapshot',{targetSocketId,requestId,time:currentTime(),paused:els.video.paused,subtitleUrl:state.activeSubtitleUrl,subtitleOffsetMs:state.subtitleOffsetMs,audioTrackIndex:state.selectedAudioTrackIndex});});
socket.on('syncSnapshot',data=>{enqueue(async()=>{if(data?.videoFile&&data.videoFile!==videoFile)return;if(!matchesActiveSyncRequest(data))return;traceStartupStep(`socket:snapshot ${Math.round(Number(data?.time)||0)}s`);const settleSnapshot=matchingSeekSnapshot(data);if(settleSnapshot)clearPendingSeekResync();state.latencyMs=data?.serverTimestamp?Math.max(0,Date.now()-data.serverTimestamp):state.latencyMs;if(data?.audioTrackIndex!==undefined&&data.audioTrackIndex!==null)await setAudioTrackSelection(data.audioTrackIndex,{broadcast:false,silent:true});const driftMs=await syncTo(data?.time,{threshold:settleSnapshot?SNAPSHOT_SEEK_SETTLE_DRIFT:0.05,resume:!(data?.paused),reason:settleSnapshot?'seek-settle-snapshot':'snapshot'});recordPlaybackEvent('snapshot',`${Math.round(Number(data?.time)||0)}s`,{seekId:data?.seekId||null,source:settleSnapshot?'seek-settle-snapshot':'snapshot',playbackMode:currentPlaybackMode(),driftMs});if(data?.paused)els.video.pause();else{if(mobile()){const ready=await requestLandscapeViewing({reusePrimed:true});if(!ready){traceStartupStep('socket:snapshot-blocked');state.sessionStarted=false;showJoinOverlay();updatePortraitGate();completeSyncRequest();updateSyncStatus();return;}}else await ensureDesktopFullscreen();const started=await tryPlay(true,null,{timeoutMs:iosCompat()?1400:2200,context:'sync-snapshot'});if(!started){traceStartupStep('socket:snapshot-timeout');state.sessionStarted=false;showJoinOverlay();updatePortraitGate();completeSyncRequest();updateSyncStatus();return;}state.sessionStarted=true;hideJoinOverlay({immediate:true});}setSubtitleOffset(data?.subtitleOffsetMs??state.subtitleOffsetMs,{broadcast:false,notify:false});if(data?.subtitleUrl!==undefined){try{await setSubtitle(data.subtitleUrl||null,{silent:true});}catch(error){console.error('[SYNC SNAPSHOT]',error);}}completeSyncRequest();updateSyncStatus();if(!settleSnapshot)status('Resynced with partner',1500);});});
socket.on('playRequestTimedOut',()=>{state.startingSession=false;completeSyncRequest();renderJoinOverlay();status('Partner never became ready. Playback stayed paused to keep sync intact.',3500);});
socket.on('partnerLeft',()=>{recordPlaybackEvent('partner-left');webcamController.handlePartnerLeft();els.video.pause();state.isWatchingAlone=true;state.isPartnerReady=true;state.lastHeartbeatAt=0;state.startingSession=false;completeSyncRequest();updateLeaderSync();updateSyncHealth();updateSyncStatus();renderJoinOverlay();presence('Partner left', {toast:true,ms:2500});status('Your partner has left the session.',5000);saveProgress();});
socket.on('nextVideoAvailable',({available,video})=>{state.nextAvailable=Boolean(available);state.nextVideo=video||null;updateEpisodeButtons();if(state.nextAvailable&&state.nextVideo)void preloadEpisode(state.nextVideo);});
socket.on('previousVideoAvailable',({available,video})=>{state.prevAvailable=Boolean(available);state.prevVideo=video||null;updateEpisodeButtons();});
socket.on('nextEpisodeCountdownStart',({video,countdownSeconds})=>{if(video)startNextEpisodeCountdown(video,countdownSeconds);});
socket.on('nextEpisodeCountdownCancel',()=>{clearNextEpisodeCountdown();status('Next episode cancelled',1200);});
socket.on('loadNextVideo',({video})=>{clearNextEpisodeCountdown();status('Loading next episode...',1500);window.setTimeout(()=>{goToVideo(video,{autoplay:true});},900);});
socket.on('loadPreviousVideo',({video})=>{clearNextEpisodeCountdown();status('Loading previous episode...',1500);window.setTimeout(()=>{goToVideo(video,{autoplay:true});},900);});
socket.on('subtitleOffsetUpdate',data=>{if(data?.videoFile!==videoFile)return;setSubtitleOffset(data.offset,{broadcast:false});});
socket.on('subtitleSelectionUpdate',data=>{if(data?.videoFile!==videoFile)return;enqueue(async()=>{try{await setSubtitle(data.subtitleUrl||null,{silent:true});status(`Synchronized subtitles: ${data.language||'Off'}`,1500);}catch(error){console.error('[SUBTITLES]',error);}});});
socket.on('audioTrackSelectionUpdate',data=>{if(data?.videoFile!==videoFile)return;enqueue(async()=>{try{await setAudioTrackSelection(data.audioTrackIndex,{broadcast:false,silent:true});status(`Synchronized audio: ${data.label||'Track updated'}`,1500);}catch(error){console.error('[AUDIO]',error);}});});

els.playPause.onclick=()=>{if(!state.hasJoined)return;if(els.video.paused){if(state.isWatchingAlone&&!window.confirm('Your partner has left the session. Continue watching alone?'))return;state.isWatchingAlone=false;void (async()=>{if(mobile()){const ready=await requestLandscapeViewing({allowIosGestureAttempt:true});if(!ready)return;}else{const ready=await requestDesktopViewing();if(!ready)return;}requestPlay();})();return;}requestPause();};
els.rewind.onclick=()=>{void seekTo(currentTime()-10);};
els.forward.onclick=()=>{void seekTo(currentTime()+30);};
els.next.onclick=()=>{if(!state.nextAvailable||!state.nextVideo)return;if(state.hasJoined){socket.emit('requestNextVideo',{videoFile});return;}goToVideo(state.nextVideo,{autoplay:true});};
els.prev.onclick=()=>{if(!state.prevAvailable||!state.prevVideo)return;if(state.hasJoined){socket.emit('requestPreviousVideo',{videoFile});return;}goToVideo(state.prevVideo,{autoplay:true});};
els.seekBar.addEventListener('input',()=>{state.isScrubbing=true;const value=Number(els.seekBar.value);state.seekPreviewTime=value;state.seekPreviewClientX=null;els.time.textContent=`${fmt(value)} / ${fmt(duration())}`;updateSeekVisuals();});
els.seekBar.addEventListener('change',()=>{const value=Number(els.seekBar.value);state.isScrubbing=false;hideSeekPreview();updateSeekVisuals();void seekTo(value);});
els.seekBar.addEventListener('pointerenter',event=>{if(mobile())return;state.seekPreviewTime=previewTimeFromClientX(event.clientX);state.seekPreviewClientX=event.clientX;updateSeekVisuals();});
els.seekBar.addEventListener('pointermove',event=>{if(mobile()||state.isScrubbing)return;state.seekPreviewTime=previewTimeFromClientX(event.clientX);state.seekPreviewClientX=event.clientX;updateSeekVisuals();});
els.seekBar.addEventListener('pointerleave',()=>{if(state.isScrubbing)return;hideSeekPreview();});
els.volumeButton.onclick=()=>{els.video.muted=!els.video.muted;state.userMuted=els.video.muted;if(!els.video.muted&&els.video.volume===0){els.video.volume=1;els.volumeBar.value='1';}updateVolume();};
els.volumeBar.addEventListener('input',()=>{const value=Number.parseFloat(els.volumeBar.value);if(Number.isFinite(value)){els.video.volume=value;els.video.muted=value===0;state.userMuted=els.video.muted;updateVolume();}});
els.settingsButton.addEventListener('click',event=>{event.stopPropagation();if(settingsPanelOpen())closeSettingsPanel();else openSettingsPanel('home');showUi();});
els.settingsBackButton?.addEventListener('click',event=>{event.stopPropagation();setSettingsView('home');showUi();});
els.closeSettingsButton?.addEventListener('click',()=>{closeSettingsPanel();showUi();});
els.closeSettingsFooter?.addEventListener('click',()=>{closeSettingsPanel();showUi();});
document.querySelectorAll('[data-settings-target]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();setSettingsView(String(button.dataset.settingsTarget||'home'));showUi();}));
els.settingsPanel.addEventListener('click',event=>{if(event.target===els.settingsPanel){closeSettingsPanel();showUi();return;}event.stopPropagation();});
document.addEventListener('click',event=>{const target=event.target;if(!els.settingsPanel.contains(target)&&!els.settingsButton.contains(target))closeSettingsPanel();if(state.inviteMenuOpen&&!els.inviteMenu?.contains(target)&&!els.userCount?.contains(target))closeInviteMenu();});
els.playbackMode.addEventListener('change',()=>{setPlaybackModeState(els.playbackMode.value,{persist:true});void loadSource({time:currentTime(),resume:!els.video.paused,reason:'playback-mode-change'}).then(()=>status(`Playback mode: ${els.playbackMode.selectedOptions[0].textContent}`,1800));});
els.audioSelect?.addEventListener('change',()=>{void setAudioTrackSelection(els.audioSelect.value,{broadcast:true});});
const updateSubtitleStyleFromControls=()=>{applySubtitleStyle({fontSize:els.subtitleStyleSize.value,color:els.subtitleStyleColor.value,backgroundAlpha:els.subtitleStyleBg.value,bottom:`${els.subtitleStylePosition.value}px`});renderSubtitle();};
els.subtitleStyleSize.addEventListener('input',updateSubtitleStyleFromControls);
els.subtitleStylePosition.addEventListener('input',updateSubtitleStyleFromControls);
subtitleColorSwatches.forEach(button=>button.addEventListener('click',()=>{els.subtitleStyleColor.value=String(button.dataset.subtitleColor||'#ffffff').toLowerCase();updateSubtitleStyleFromControls();}));
subtitleBackgroundButtons.forEach(button=>button.addEventListener('click',()=>{els.subtitleStyleBg.value=String(button.dataset.subtitleBg||'0');updateSubtitleStyleFromControls();}));
els.subtitleStyleReset.addEventListener('click',()=>{applySubtitleStyle(defaultSubtitleStyle());renderSubtitle();status('Subtitle style reset',1500);});
els.resyncButton?.addEventListener('click',()=>{if(!state.hasJoined||state.currentUsers<2){status('No partner available to resync with',1500);return;}requestLiveSync('manual',{force:true});closeSettingsPanel();});
els.webcamToggleButton?.addEventListener('click',()=>{void webcamController.toggleCamera();});
els.userCount?.addEventListener('click',event=>{event.stopPropagation();toggleInviteMenu();});
els.inviteMenu?.addEventListener('click',event=>event.stopPropagation());
els.inviteMenuCopy?.addEventListener('click',()=>{if(!state.shareUrl)return;closeInviteMenu();void copyText(state.shareUrl,'Invite link copied');});
els.installButton?.addEventListener('click',async()=>{if(!deferredInstallPrompt){status('Install is not available on this device',1800);return;}const promptEvent=deferredInstallPrompt;deferredInstallPrompt=null;updateInstallButton();closeSettingsPanel();try{await promptEvent.prompt();const choice=await promptEvent.userChoice;if(choice?.outcome==='accepted')status('Install prompt opened',1800);}catch(error){console.error('[INSTALL]',error);status('Unable to open install prompt',2200);}});
els.countdownPlayNow.addEventListener('click',()=>{if(!state.activeCountdownVideo)return;if(state.hasJoined)socket.emit('confirmNextEpisodeCountdown',{video:state.activeCountdownVideo});else goToVideo(state.activeCountdownVideo,{autoplay:true});});
els.countdownCancel.addEventListener('click',()=>{if(state.hasJoined)socket.emit('cancelNextEpisodeCountdown');else clearNextEpisodeCountdown();});
els.subtitleBack.onclick=()=>{if(!state.activeSubtitleUrl){status('No subtitles active',1500);return;}setSubtitleOffset(state.subtitleOffsetMs-SUBTITLE_OFFSET_STEP_MS);};
els.subtitleForward.onclick=()=>{if(!state.activeSubtitleUrl){status('No subtitles active',1500);return;}setSubtitleOffset(state.subtitleOffsetMs+SUBTITLE_OFFSET_STEP_MS);};
els.subtitleReset.onclick=()=>{if(!state.activeSubtitleUrl){status('No subtitles active',1500);return;}setSubtitleOffset(0,{notify:false});status('Subtitle timing reset',1500);};
els.pipButton?.addEventListener('click',()=>{void togglePip();});
els.portraitGateRotate?.addEventListener('click',()=>{void requestLandscapeViewing({allowIosGestureAttempt:true});});
els.fullscreen.onclick=()=>{if(!fullscreenActive()&&mobile()){void requestPlayerFullscreen({preferLandscape:true});return;}toggleFullscreen();};
const surfaceTapControlsUi=()=>fullscreenActive()||compactLandscapeActive();
const handleMobileSurfaceTap=()=>{if(els.prompt.style.display==='flex'){els.prompt.click();return;}if(!els.videoWrapper.classList.contains('ui-visible')){showUi();return;}hideUi();};
const handlePrimarySurfaceClick=()=>{if(surfaceTapControlsUi()){handleMobileSurfaceTap();return;}showUi();if(els.prompt.style.display==='flex'){els.prompt.click();return;}els.playPause.click();};
let lastSurfaceTouchAt=0;
els.clickInterceptor.addEventListener('pointerup',event=>{if(event.pointerType==='mouse')return;event.preventDefault();lastSurfaceTouchAt=Date.now();handlePrimarySurfaceClick();});
els.clickInterceptor.addEventListener('click',()=>{if((Date.now()-lastSurfaceTouchAt)<450)return;handlePrimarySurfaceClick();});
els.video.addEventListener('click',()=>{if(!mobile()||(Date.now()-lastSurfaceTouchAt)<450)return;handleMobileSurfaceTap();});
els.mobilePlayToggle?.addEventListener('click',event=>{event.stopPropagation();showUi();els.playPause.click();});
els.prompt.addEventListener('click',async()=>{els.prompt.classList.remove('is-visible');els.prompt.style.display='none';hideStatus();state.pendingPrompt=null;restoreAudiblePlayback();if(mobile()){const ready=await requestLandscapeViewing({allowIosGestureAttempt:true});if(!ready)return;}else{const ready=await requestDesktopViewing();if(!ready)return;}try{await tryPlay(false);}catch(error){console.error('[PLAYER]',error);status('Unable to start playback. Please try again.',3000);}});
els.joinButton.addEventListener('click',async()=>{traceStartupStep(`join:click users=${state.currentUsers} leader=${state.isLeader?'yes':'no'} joined=${state.hasJoined?'yes':'no'}`);storageSet(sessionStorage,'hasInteracted','true');storageSet(localStorage,interactionKey,'true');if(!state.lobbyPrepared){await ensureLobbyPrepared();return;}if(!state.hasJoined){if(!socket.connected)socket.connect();requestLobbyStateSync();status('Joining room...',1800);renderJoinOverlay();return;}if(!canStartFromLobby()){requestLobbyStateSync();status(state.currentUsers>1?'Waiting for both viewers to be ready...':'Joining room...',1800);renderJoinOverlay();return;}if(state.currentUsers>1&&!state.isLeader){requestLobbyStateSync();status('Waiting for your partner to start the session',1800);renderJoinOverlay();return;}if(mobile()){const ready=await requestLandscapeViewing({allowIosGestureAttempt:true});traceStartupStep(`join:viewing ${ready?'ready':'blocked'}`);if(!ready){renderJoinOverlay();return;}}else{const ready=await requestDesktopViewing();if(!ready){renderJoinOverlay();return;}}state.startingSession=true;renderJoinOverlay();requestPlay();});
els.joinCopyButton?.addEventListener('click',()=>{if(!state.shareUrl)return;void copyText(state.shareUrl,'Invite link copied');});
if(mobile())els.joinButton.addEventListener('touchstart',event=>{event.preventDefault();els.joinButton.click();},{passive:false});

els.video.addEventListener('play',()=>{restoreAudiblePlayback();updatePlayPause();updateLeaderSync();syncMediaSessionPlaybackState();syncMediaSessionPosition();if(!state.uiLockedHidden)showUi();});
els.video.addEventListener('playing',()=>{traceStartupStep('media:playing');state.bufferIssueCount=0;state.lastBufferIssueAt=0;setReady(true,'playing');restoreAudiblePlayback();updatePlayPause();updateLeaderSync();syncMediaSessionPlaybackState();syncMediaSessionPosition();});
els.video.addEventListener('webkitbeginfullscreen',()=>{traceStartupStep('media:webkitbeginfullscreen');handleFs();});
els.video.addEventListener('webkitendfullscreen',()=>{traceStartupStep('media:webkitendfullscreen');handleFs();});
els.video.addEventListener('pause',()=>{updatePlayPause();updateLeaderSync();syncMediaSessionPlaybackState();syncMediaSessionPosition();showUi();clearTimeout(state.uiTimer);});
els.video.addEventListener('enterpictureinpicture',()=>{trackPlayback('pip-open');updatePipButton();syncNativeSubtitleTrack({forceVisible:true});updatePortraitGate();syncMediaSessionPlaybackState();});
els.video.addEventListener('leavepictureinpicture',()=>{trackPlayback('pip-close');updatePipButton();updateNativeSubtitleTrackMode();if(mobile()&&!fullscreenActive())void requestLandscapeViewing();updatePortraitGate();syncMediaSessionPlaybackState();});
els.video.addEventListener('volumechange',()=>{els.volumeBar.value=String(els.video.volume);updateVolume();});
els.video.addEventListener('loadedmetadata',()=>{traceStartupStep('media:metadata');syncUi();updateSeekVisuals(null);syncMediaSession();if(directPlaybackMode())applyNativeAudioTrackSelection();});
els.video.addEventListener('progress',()=>{updateSeekVisuals();});
els.video.addEventListener('loadeddata',()=>{if(state.sourceLoadingCount===0)state.sourceReady=true;traceStartupStep('media:loadeddata');setReady(els.video.readyState>=READY,'loadeddata');});
els.video.addEventListener('canplay',()=>{if(state.sourceLoadingCount===0)state.sourceReady=true;traceStartupStep('media:canplay');setReady(true,'canplay');requestFollowerLobbySync('canplay',{force:true});});
els.video.addEventListener('canplaythrough',()=>{if(state.sourceLoadingCount===0)state.sourceReady=true;traceStartupStep('media:canplaythrough');setReady(true,'canplaythrough');});
els.video.addEventListener('waiting',()=>{const bufferedSeconds=bufferedAhead().toFixed(2);traceStartupStep(`media:waiting ${bufferedSeconds}s`);setReady(false,'waiting');const withinPostSeekCooldown=seekWindowActive()&&(Date.now()-state.lastSeekAt)<SEEK_BUFFER_SYNC_COOLDOWN_MS;trackPlayback('buffer-waiting',`${bufferedSeconds}s buffered`,{seekId:state.activeSeekId,source:withinPostSeekCooldown?'post-seek-cooldown':'buffer-waiting',playbackMode:currentPlaybackMode(),driftMs:state.lastDriftMs});if(state.sessionStarted&&(Date.now()-state.lastSeekAt)<2500&&!withinPostSeekCooldown){if(state.isLeader)scheduleLeaderSeekSync('waiting',state.activeSeekId);else requestLiveSync('seek-waiting',{silent:true,force:true});}maybeRecoverFromStartupBuffer('waiting');});
els.video.addEventListener('stalled',()=>{const bufferedSeconds=bufferedAhead().toFixed(2);traceStartupStep(`media:stalled ${bufferedSeconds}s`);setReady(false,'stalled');const withinPostSeekCooldown=seekWindowActive()&&(Date.now()-state.lastSeekAt)<SEEK_BUFFER_SYNC_COOLDOWN_MS;trackPlayback('buffer-stalled',`${bufferedSeconds}s buffered`,{seekId:state.activeSeekId,source:withinPostSeekCooldown?'post-seek-cooldown':'buffer-stalled',playbackMode:currentPlaybackMode(),driftMs:state.lastDriftMs});if(state.sessionStarted&&(Date.now()-state.lastSeekAt)<2500&&!withinPostSeekCooldown){if(state.isLeader)scheduleLeaderSeekSync('stalled',state.activeSeekId);else requestLiveSync('seek-stalled',{silent:true,force:true});}maybeRecoverFromStartupBuffer('stalled');});
els.video.addEventListener('seeking',()=>setReady(false,'seeking'));
els.video.addEventListener('seeked',()=>{setReady(els.video.readyState>=READY,'seeked');syncMediaSessionPosition();});
els.video.addEventListener('timeupdate',()=>{if(!state.isScrubbing)syncUi();else updateSeekVisuals();syncMediaSessionPosition();renderSubtitle();if(duration()>0&&!state.markedWatched&&state.hasJoined&&((currentTime()/duration())*100)>=WATCHED_AT){socket.emit('markVideo',{videoFile,watched:true});state.markedWatched=true;}});
els.video.addEventListener('ended',()=>{if(!state.nextAvailable||!state.nextVideo)return;if(state.hasJoined){socket.emit('startNextEpisodeCountdown',{video:state.nextVideo,countdownSeconds:8});return;}startNextEpisodeCountdown(state.nextVideo,8);});
els.video.addEventListener('error',()=>{const error=els.video.error;if(!error){trackPlayback('playback-error','unknown');status('Video playback error',4000);return;}const mode=currentPlaybackMode();if((error.code===3||error.code===4)&&mode==='original'){trackPlayback('data-saver-fallback',`code=${error.code}`);setPlaybackModeState('data-saver');void loadSource({time:currentTime(),resume:false,reason:'data-saver-fallback'}).then(()=>status('Using Data Save Mode for this session',3000));return;}const message={1:'Video loading was aborted',2:'Network error while loading video',3:'Video format not supported on this device',4:'Video source not available'}[error.code]||'Video playback error';trackPlayback('playback-error',message);status(message,5000);});

const handleFs=()=>{if(state.pseudoFullscreen&&nativeFullscreenActive())state.pseudoFullscreen=false;const isFs=fullscreenActive();if(!isFs)unlockOrientation();document.body.classList.toggle('fullscreen-active',isFs);els.videoWrapper.classList.toggle('pseudo-fullscreen',state.pseudoFullscreen);els.fullscreen.innerHTML=isFs?fsExit:fsEnter;els.breadcrumb.style.display=isFs?'none':'';els.back.style.display=isFs?'flex':'none';if(android()&&isFs&&pipAvailable()&&!els.video.paused)status('Press Home to keep watching in the mini-player',2200);syncMobileLayout();const unexpectedMobileExit=mobile()&&state.sessionStarted&&!isFs&&!state.returnToLobbyAfterFullscreenExit&&els.joinOverlay?.style.display==='none'&&document.pictureInPictureElement!==els.video;if(unexpectedMobileExit&&Date.now()<state.ignoreFullscreenExitUntil){traceStartupStep('fullscreen:transient-exit-ignored');updatePortraitGate();showUi();return;}if(unexpectedMobileExit){returnToEpisodeStartScreen();return;}updatePortraitGate();if(!isFs&&state.returnToLobbyAfterFullscreenExit){state.returnToLobbyAfterFullscreenExit=false;showJoinOverlay();}showUi();};
document.addEventListener('fullscreenchange',handleFs);
document.addEventListener('webkitfullscreenchange',handleFs);
document.addEventListener('mozfullscreenchange',handleFs);
document.addEventListener('MSFullscreenChange',handleFs);
document.addEventListener('keydown',event=>{const tag=document.activeElement?.tagName||'';if(tag==='INPUT'||tag==='SELECT')return;switch(event.key.toLowerCase()){case' ':event.preventDefault();els.playPause.click();break;case'f':event.preventDefault();toggleFullscreen();break;case'i':event.preventDefault();void togglePip();break;case'm':event.preventDefault();els.volumeButton.click();break;case'arrowleft':event.preventDefault();void seekTo(currentTime()-10);break;case'arrowright':event.preventDefault();void seekTo(currentTime()+30);break;case'g':event.preventDefault();if(state.activeSubtitleUrl)els.subtitleBack.click();break;case'h':event.preventDefault();if(state.activeSubtitleUrl)els.subtitleForward.click();break;default:break;}});
els.videoWrapper.addEventListener('mousemove',showUi);
els.videoWrapper.addEventListener('touchstart',showUi,{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible'){syncMediaSessionPlaybackState();return;}updatePortraitGate();if(mobile()&&state.sessionStarted&&els.joinOverlay?.style.display==='none'&&!landscapeViewingReady()&&document.pictureInPictureElement!==els.video){showJoinOverlay();}showUi();syncMediaSession();if(socket.connected){emitLobbyReadyState({force:true});requestFollowerLobbySync('visibility-return',{force:true});}});
window.addEventListener('online',()=>{refreshCapabilities();showUi();requestFollowerLobbySync('network-return',{force:true});});
window.addEventListener('resize',()=>{syncMobileLayout();updatePortraitGate();renderInviteMenu();refreshCapabilities();showUi();},{passive:true});
window.addEventListener('scroll',()=>{if(state.inviteMenuOpen)positionInviteMenu();},{passive:true});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;updateInstallButton();});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updateInstallButton();status('Tvstack installed',2000);});
installDisplayModeQuery?.addEventListener?.('change',updateInstallButton);
window.addEventListener('beforeunload',cleanup);
window.addEventListener('pagehide',cleanup);

syncMobileLayout();
updatePortraitGate();
updateInstallButton();
void init().catch(error=>{console.error('[PLAYER]',error);status(error.message||'Failed to initialize player',5000);});
});
