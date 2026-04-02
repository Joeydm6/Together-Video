# TogetherVideo Verbeteringen

Dit document bundelt de gekozen uitbreidingen voor TogetherVideo en werkt voor ieder punt een concreet plan uit. De focus blijft: stabiele remote sync, snelle library-navigatie en een eenvoudige UX op desktop, tablet en mobiel.

## Prioriteiten

### P0
- Room codes / share links
- Live sync diagnostics
- Download-free remote mode
- Device capability detection

### P1
- Multi-audio selectie
- Subtitle style settings
- Next episode countdown
- Invite-presence UX
- Preload next episode

### P2
- TMDB cache en metadata lock
- Zoekfunctie
- Favorieten / watchlist
- Continue watching reset / cleanup UI
- Installable desktop/web app

## Uitgevoerde Optimalisatiebatch

Status van de laatste batch:

- Zoek UX afmaken: gedaan
  De zoekbalk heeft nu recente zoekopdrachten, snelchips, resultaatsamenvatting en toetsenbordnavigatie bovenop de in-memory search index.
- Room diagnostics pagina: gedaan
  Er is nu een aparte `/diagnostics.html` pagina die actieve rooms, sync-snapshots en telemetry live toont.
- PiP / mini-player support: gedaan
  De player heeft nu Picture-in-Picture / mini-player ondersteuning met knop en keyboard shortcut (`I`) waar de browser dit ondersteunt.
- Search index in memory: gedaan
  Zoekresultaten komen uit een tijdelijke in-memory index in plaats van telkens de hele library opnieuw te scannen.
- TMDB cache strakker: gedaan
  Success, pinned matches en misses hebben nu eigen TTL-gedrag.
- Probe/thumbnail queueing: gedaan
  Thumbnail generatie loopt nu via een queue om dubbele of concurrerende probe/ffmpeg-requests te voorkomen.
- Homepage/directory response caching: gedaan
  Homepage- en directoryresponses worden kort gecachet en bij relevante writes/invalidation ververst.
- Player.js opsplitsen: gestart
  Capabilities, diagnostics formatting en telemetry reporting zijn uit `player.js` gehaald naar aparte modules.
- Room state persistenter maken: gedaan
  Room state en laatste sync-snapshots worden naar disk weggeschreven en bij restart gehydrateerd.
- Meer smoke-tests: gedaan
  Responsive smoke is uitgebreid en er komen checks bij voor diagnostics en mini-player gedrag.
- Playback telemetry: gedaan
  Er is nu server-side opslag en client-side emissie voor playback- en sync-events.

## 1. Room Codes / Share Links

### Doel
Een gebruiker moet een sessie expliciet kunnen delen met iemand anders, zonder dat de tweede gebruiker handmatig dezelfde video en context hoeft te openen.

### Waarom
- Remote gebruik wordt veel eenvoudiger.
- Minder kans op verkeerde video of verkeerde aflevering.
- Het geeft TogetherVideo een duidelijker sessiemodel dan alleen "zelfde video = zelfde room".

### Plan
1. Voeg server-side room-objecten toe met:
   - `roomCode`
   - `videoFile`
   - `createdAt`
   - `leaderSocketId`
   - `syncSnapshot`
   - `inviteExpiry`
2. Maak een endpoint voor room-creatie:
   - `POST /api/rooms`
   - response bevat `roomCode` en deelbare URL
3. Maak join via:
   - `GET /join/:roomCode`
   - of `player.html?room=ABCD12`
4. Laat de player bij room-join eerst room-data ophalen en daarna pas de video laden.
5. Toon een simpele share UI:
   - "Copy invite link"
   - "Copy room code"
6. Laat room-codes verlopen na inactiviteit.
7. Voeg room-validatie toe:
   - room bestaat
   - room niet vol
   - room verwijst naar geldige video

### Technische aanpak
- Nieuwe room-store in memory als eerste versie.
- Later optioneel persistente store als er behoefte is aan langere sessies.
- Socket-join flow wijzigen van alleen `videoFile` naar `videoFile + roomCode`.

### Acceptatiecriteria
- Een gebruiker kan een room-link kopieren en delen.
- Een tweede gebruiker opent de link en komt direct in dezelfde sessie.
- Room-handoff blijft werken na reconnect.
- Oude of ongeldige room-codes geven nette foutmeldingen.

## 3. Live Sync Diagnostics

### Doel
Gebruikers en jijzelf moeten direct kunnen zien hoe gezond de sync is.

### Waarom
- Debugging van remote problemen wordt veel sneller.
- Gebruikers begrijpen beter waarom iets wacht of corrigeert.
- Dit helpt bij mobiel/wifi/4G issues.

### Plan
1. Voeg een compacte diagnostics overlay toe in de player.
2. Toon minimaal:
   - leader/follower status
   - partner ready state
   - laatste heartbeat
   - geschatte latency
   - actuele drift
   - reconnect status
3. Voeg een uitgebreide debug-weergave toe achter een toggle in settings.
4. Log sync-events op client-side in een ring buffer:
   - `play`
   - `pause`
   - `seek`
   - `syncSnapshot`
   - `heartbeat`
   - `reconnect`
5. Maak een server diagnostic endpoint:
   - actieve rooms
   - leaders
   - room state
   - pending actions
6. Voeg een "copy diagnostics" knop toe voor support/debug.

### Technische aanpak
- Diagnostics als lichtgewicht object in `player.js`.
- Geen zware logging naar disk in eerste fase.
- Alleen relevante sync-data in memory houden.

### Acceptatiecriteria
- Gebruiker ziet leader/follower en sync-status live in beeld.
- Drift en latency worden zichtbaar geüpdatet.
- Reconnect en snapshot-events zijn achteraf uitleesbaar.

## 5. Multi-Audio Selectie

### Doel
Gebruikers moeten audiotracks kunnen wisselen bij bestanden met meerdere audio streams.

### Waarom
- Nodig voor anime, dual-audio releases en internationale films/series.
- Past logisch naast subtitlebeheer.

### Plan
1. Breid `/api/video-info` of een apart endpoint uit met audio tracks:
   - index
   - language
   - codec
   - default flag
2. Maak in settings een audio-sectie.
3. Voor directe playback:
   - gebruik browser native audio track support waar beschikbaar
4. Voor problematische/transcoded bestanden:
   - geef gekozen track mee aan ffmpeg
5. Sync audio-keuze tussen gebruikers in dezelfde room.
6. Sla audio-voorkeur per video lokaal op.

### Technische aanpak
- Eerst focus op server-side detectie via ffprobe.
- Daarna player UI.
- Tenslotte transcodepad uitbreiden met audio track mapping.

### Acceptatiecriteria
- Audio tracks verschijnen in settings als ze bestaan.
- Wisselen van track werkt op directe en getranscodeerde paden.
- Partner krijgt dezelfde audio-keuze bij sync.

## 6. Subtitle Style Settings

### Doel
Gebruikers moeten subtitles naar voorkeur kunnen aanpassen.

### Waarom
- Beter leesbaar op mobiel en tv.
- Verschillende gebruikers hebben andere voorkeuren.

### Plan
1. Voeg subtitle stijl-instellingen toe:
   - font size
   - text color
   - background/outline strength
   - vertical position
2. Sla voorkeuren op in localStorage.
3. Maak live preview in de player.
4. Gebruik CSS custom properties voor rendering.
5. Houd timing-offset sync gescheiden van style settings:
   - offset mag room-wide syncen
   - stijl blijft standaard per gebruiker
6. Voeg optie toe om stijl-instellingen te resetten.

### Technische aanpak
- Subtitle rendering gebruikt al een custom container; dat is de juiste plek.
- Nieuwe instellingen hoeven geen backend-wijziging te hebben.

### Acceptatiecriteria
- Subtitles kunnen groter/kleiner en duidelijker worden gemaakt.
- Instellingen blijven bewaard na refresh.
- Sync van subtitle-selectie blijft werken.

## 7. Next Episode Countdown

### Doel
De overgang naar de volgende aflevering moet rustiger en duidelijker worden.

### Waarom
- Automatisch doorschakelen zonder context voelt abrupt.
- Gebruikers willen soms annuleren of terugspoelen.

### Plan
1. Vervang directe next-episode start door countdown overlay.
2. Toon:
   - volgende episode titel
   - countdown timer
   - "Play now"
   - "Cancel"
3. Sync countdown-status tussen beide gebruikers.
4. Voeg instelling toe:
   - auto-next aan/uit
5. Preload intussen al metadata/thumbnail van de volgende aflevering.

### Technische aanpak
- Nieuwe socket-events:
   - `startNextCountdown`
   - `cancelNextCountdown`
   - `confirmNextVideo`
- Fallback naar huidige flow als er geen volgende aflevering is.

### Acceptatiecriteria
- Einde aflevering toont countdown i.p.v. directe redirect.
- Beide gebruikers zien dezelfde countdown.
- Cancel voorkomt het laden van de volgende aflevering.

## 10. Invite-Presence UX

### Doel
De gebruiker moet altijd weten wat de andere partij aan het doen is.

### Waarom
- Vermindert verwarring tijdens remote gebruik.
- Maakt de tool menselijker zonder chat nodig te hebben.

### Plan
1. Voeg presence-states toe:
   - partner invited
   - partner joining
   - partner connected
   - partner buffering
   - partner left
   - partner reconnected
2. Toon deze states als subtiele statusmeldingen.
3. Voeg room-presence toe aan share-link flow.
4. Maak join-overlay slimmer:
   - "Waiting for partner"
   - "Partner is loading the video"
5. Voeg korte audit trail toe in diagnostics.

### Technische aanpak
- Aanvulling op bestaande socket presence events.
- Geen zware backend-wijziging nodig als room-model al bestaat.

### Acceptatiecriteria
- Gebruikers zien duidelijk wanneer de andere persoon aan het joinen of bufferen is.
- Presence wordt bijgewerkt bij reconnect en disconnect.

## 13. Download-Free Remote Mode

### Doel
Remote playback moet zich slimmer aanpassen aan netwerk en apparaat, zonder dat de gebruiker hoeft te begrijpen wat transcoding doet.

### Waarom
- Buiten LAN is uplink vaak de bottleneck.
- Niet ieder apparaat kan elk formaat even goed aan.

### Plan
1. Voeg een remote playback mode toe:
   - `Auto (recommended)`
   - `Original`
   - `Compatibility`
   - `Data saver`
2. Laat de server op basis van device + netwerkprofiel betere defaults kiezen.
3. Voeg bitrate/quality profielen toe voor remote transcoding.
4. Laat de player bij playback errors automatisch een compatibele fallback proberen.
5. Toon een nette melding:
   - "Switched to compatibility mode"
6. Meet time-to-first-frame en playback failures voor tuning.

### Technische aanpak
- Bouw op bestaande `quality` en `isProblematic` logica.
- Voeg server-side profielmapping toe:
   - mobiel
   - tablet
   - desktop
   - slechte verbinding

### Acceptatiecriteria
- Gebruiker op mobiel netwerk krijgt sneller een werkende stream.
- Playback error probeert eerst automatische fallback.
- Compatibility mode blijft sync-stabiel.

## 14. Preload Next Episode

### Doel
De volgende aflevering moet sneller starten.

### Waarom
- Minder wachttijd tussen afleveringen.
- Past goed samen met next-episode countdown.

### Plan
1. Vraag vroegtijdig next-episode metadata op.
2. Preload:
   - videoinfo
   - subtitles
   - thumbnail/poster
3. Optioneel prewarm probe-cache op de server.
4. Start dit alleen als:
   - er een volgende aflevering is
   - huidige playback ver genoeg gevorderd is
   - systeem niet al zwaar belast is
5. Voeg guardrails toe om onnodige netwerkbelasting te voorkomen.

### Technische aanpak
- Geen volledige video-prefetch in eerste fase.
- Alleen lichte metadata- en cachewarming.

### Acceptatiecriteria
- Overgang naar volgende aflevering voelt merkbaar sneller.
- Geen extra sync-instabiliteit.

## 15. TMDB Cache en Metadata Lock

### Doel
Metadata moet sneller laden en stabiel blijven.

### Waarom
- Minder externe afhankelijkheid.
- Minder wisselende poster/backdrop matches.
- Snellere library-ervaring.

### Plan
1. Voeg disk-cache toe voor TMDB antwoorden.
2. Cache:
   - zoekresultaten
   - serie details
   - seizoen info
   - posters/backdrops
3. Voeg "metadata lock" toe:
   - handmatig gekozen match opslaan
   - niet steeds opnieuw overrulen
4. Voeg refresh-knop toe voor geforceerde re-fetch.
5. Voeg TTL-regels toe:
   - lange TTL voor locked metadata
   - kortere TTL voor unlocked metadata

### Technische aanpak
- Cachebestanden in `.cache/tmdb`.
- Lock-map op basis van canonical series path.

### Acceptatiecriteria
- Library laadt sneller bij herhaald gebruik.
- Gecorrigeerde metadata blijft stabiel.

## 15b. Thumbnail Validatie en Handmatige Keuze

### Doel
Thumbnails moeten veel vaker direct kloppen, en de gebruiker moet een verkeerde series-thumbnail handmatig kunnen vervangen.

### Waarom
- Auto-thumbnails pakken te vaak een zwart frame, title card of verkeerde scène.
- Bij series wil je soms liever een andere episode-frame of TMDB-poster kiezen.

### Plan
1. Maak automatische thumbnail-keuze slimmer:
   - gebruik metadata zoals duur
   - vermijd heel vroege frames
   - kies voor series liever een representatieve episode als bron
2. Voeg thumbnail-candidates toe:
   - manual `poster.jpg/png`
   - TMDB poster/backdrop
   - meerdere gegenereerde episode-frames
3. Voeg een serieknop toe:
   - `Change Thumbnail`
4. Open een chooser met preview-cards.
5. Sla de gekozen thumbnail per series-path op.
6. Laat homepage, series-header en continue-watching dezelfde override volgen.

### Technische aanpak
- Thumbnail overrides in cachebestand.
- Candidate-endpoint voor de library-UI.
- Automatische fallback blijft werken als er geen override is.

### Acceptatiecriteria
- Verkeerde series-thumbnail kan handmatig vervangen worden.
- De gekozen thumbnail blijft behouden na refresh/restart.
- Automatische thumbnails zijn merkbaar vaker bruikbaar.

## 16. Zoekfunctie

Status: deferred / tijdelijk uit de UI gehaald totdat de mobiele UX en betrouwbaarheid opnieuw zijn opgebouwd.

### Doel
Snel door de volledige bibliotheek zoeken.

### Waarom
- Grote bibliotheken zijn anders te traag om handmatig doorheen te bladeren.
- Vooral belangrijk op mobiel.

### Plan
1. Voeg globale search bar toe op homepage.
2. Indexeer:
   - series
   - seasons
   - episodes
   - movies
3. Toon live resultaten met duidelijke categorieën.
4. Ondersteun fuzzy matching:
   - gedeeltelijke titels
   - episode codes
5. Voeg keyboard navigation toe voor desktop.
6. Voeg recente zoekopdrachten toe.

### Technische aanpak
- Start met simpele server-side search over bestaande library data.
- Later eventueel in-memory index voor snellere responses.

### Acceptatiecriteria
- Zoeken op serie, aflevering of bestandsnaam geeft snelle resultaten.
- Resultaten zijn bruikbaar op desktop en mobiel.

## 17. Favorieten / Watchlist

### Doel
Gebruikers moeten content kunnen markeren voor snelle toegang.

### Waarom
- Handig voor terugkerende series en later bekijken.
- Verbetert homepage-ervaring.

### Plan
1. Voeg favorite toggle toe op cards en seriepagina's.
2. Maak homepage-sectie:
   - `Favorites`
   - optioneel `Watchlist`
3. Sla dit lokaal op als eerste versie.
4. Voeg sortering toe:
   - recent toegevoegd
   - alfabetisch
5. Integreer met zoekresultaten en context-menu.

### Technische aanpak
- Eerste versie in localStorage.
- Later optioneel per-profiel of server-side.

### Acceptatiecriteria
- Gebruiker kan makkelijk favorieten toevoegen en verwijderen.
- Favorieten verschijnen direct in een eigen sectie.

## 18. Continue Watching Reset / Cleanup UI

### Doel
De gebruiker moet kijkgeschiedenis makkelijk kunnen opschonen en herstellen.

### Waarom
- Continue Watching raakt snel rommelig.
- Foutieve voortgang moet snel te corrigeren zijn.

### Plan
1. Voeg bulk-acties toe:
   - remove from continue watching
   - reset progress
   - mark as unwatched
2. Maak serie-brede cleanup mogelijk.
3. Voeg bevestigingsdialogen toe voor bulk-acties.
4. Voeg optioneel filter toe:
   - alleen bijna afgekeken
   - alleen half bekeken
5. Maak direct visuele feedback na cleanup.

### Technische aanpak
- Bouw op bestaande progress API en mark/unmark flows.
- Nieuwe endpoint voor serie- of bulkprogress reset.

### Acceptatiecriteria
- Gebruiker kan individuele en bulk cleanup uitvoeren.
- Continue Watching update direct zonder refresh.

## 20. Installable Desktop / Web App

### Doel
TogetherVideo moet meer als echte app voelen op desktop en mobiel.

### Waarom
- Snellere toegang.
- Nettere UX voor herhaald gebruik.
- Handig op telefoon of tablet.

### Plan
1. Voeg web app manifest toe.
2. Voeg app icons toe in meerdere formaten.
3. Zorg dat homepage en player installable zijn.
4. Voeg minimale offline shell toe voor UI-bestanden.
5. Toon optioneel een "Install app" prompt.
6. Test op:
   - Chrome desktop
   - Android Chrome
   - iPhone Safari gedrag als web app bookmark

### Technische aanpak
- PWA-light aanpak.
- Geen echte offline videoplayback nodig; alleen app-shell gedrag.

### Acceptatiecriteria
- App kan worden toegevoegd aan startscherm of desktop.
- UI opent met app-achtige ervaring.

## 21. Device Capability Detection

### Doel
Samen met remote mode moet TogetherVideo automatisch slim reageren op het apparaat en de browser.

### Waarom
- iPhone Safari, Android Chrome en desktop hebben verschillende beperkingen.
- Minder handmatige instellingen voor de gebruiker.

### Plan
1. Detecteer:
   - mobiel/tablet/desktop
   - touch vs muis
   - vermoedelijke browserfamilie
   - schermgrootte
   - picture-in-picture/fullscreen support
   - audio/subtitle track support
2. Bepaal capability profile:
   - `desktop-full`
   - `mobile-safe`
   - `ios-compat`
   - `bandwidth-safe`
3. Gebruik profiel om defaults te kiezen:
   - quality mode
   - subtitle size
   - autoplay prompt
   - fullscreen gedrag
   - UI density
4. Toon profiel optioneel in diagnostics.
5. Houd overrides mogelijk voor power users.

### Technische aanpak
- Capability helper module in frontend.
- Profiel wordt een input voor player-initialisatie.

### Acceptatiecriteria
- App kiest betere defaults per apparaat.
- Minder playback errors op iOS/mobiel.
- Gebruiker hoeft minder handmatig te tweaken.

## Aanbevolen Implementatievolgorde

### Fase 1
- Room codes / share links
- Invite-presence UX
- Live sync diagnostics
- Device capability detection

### Fase 2
- Download-free remote mode
- Multi-audio selectie
- Subtitle style settings
- Next episode countdown
- Preload next episode

### Fase 3
- TMDB cache en metadata lock
- Zoekfunctie
- Favorieten / watchlist
- Continue watching cleanup UI
- Installable desktop / web app

## Algemene Teststrategie

Voor alle punten geldt:

1. Voeg waar mogelijk geautomatiseerde smoke-tests toe.
2. Test minimaal op:
   - desktop Chrome
   - desktop Edge
   - Android Chrome viewport
   - iPhone Safari-achtig viewport
3. Test altijd:
   - solo playback
   - 2-user sync
   - reconnect
   - subtitle flow
   - episode overgang

## Open Productkeuzes

Deze keuzes moeten nog expliciet worden gemaakt voordat alle punten worden gebouwd:

- Blijven voorkeuren lokaal per browser, of wil je profielen/server-side opslag?
- Moet audio-keuze altijd syncen, of optioneel?
- Moet subtitle style per gebruiker of per room zijn?
- Wil je een "host decides" model, of maximaal peer-symmetrisch houden?
- Wil je PWA-installatie alleen voor gemak, of ook als kernonderdeel van remote gebruik?

## Directe UX/Bugfixes

Deze punten zijn geen losse roadmapfeatures, maar directe kwaliteitsissues die mee moeten lopen in elke volgende ronde:

- Mobiele playback mag na een bewuste user action niet standaard gemute starten.
  Plan:
  - mute alleen nog afdwingen als een browser autoplay zonder gesture blokkeert
  - na `Join Session`, `Play` of een expliciete tap moet audio weer normaal starten tenzij de gebruiker zelf op mute heeft gezet
  - meenemen in mobiele smoke-tests
- Subtitle offset moet direct zichtbaar effect hebben.
  Plan:
  - offsetwijzigingen moeten meteen de actieve cue opnieuw renderen, ook als de video gepauzeerd is
  - standaard stapgrootte verhogen naar een bruikbare waarde voor echte releases
  - offset-sync tussen 2 gebruikers mee blijven testen

## Reviewronde April 2026

Concrete verbeterpunten na een code-review van de huidige video tool:

### P0

- Mobiele seek-flow stabiliseren.
  Waarom:
  - een lokale seek stuurt nu direct een `seek`, daarna vaak nog een extra `requestSyncSnapshot`, en bij de leader volgt ook nog een `syncSnapshot` als stabilisatie
  - op mobiel veroorzaakt dat meerdere snelle correcties achter elkaar, zichtbaar als flicker of een seek die even terugschiet
  Aanpak:
  - voeg seek-transacties toe met een `seekId` en een korte settle window
  - stuur niet standaard een volledige resync direct na elke seek
  - laat alleen een tweede correctie gebeuren als drift na de settle window nog echt te groot is

- Buffer-events na seek minder agressief laten resyncen.
  Waarom:
  - `waiting` en `stalled` zijn op mobiel of in data-saver mode normaal vlak na scrubben
  - die events triggeren nu extra sync-correcties terwijl de speler vaak nog gewoon bezig is met herstellen
  Aanpak:
  - introduceer een cooldown van bijvoorbeeld 1.5 tot 2 seconden na seek
  - gebruik aparte thresholds voor `post-seek`, `heartbeat` en `manual resync`

- Fullscreen/landscape-flow minder kwetsbaar maken tijdens mobiel scrubben.
  Waarom:
  - mobiele browsers kunnen tijdens seeken of UI-transities tijdelijk fullscreen-status wijzigen
  - de huidige flow kan dat interpreteren als een echte exit en terugvallen naar de join/start-overlay
  Aanpak:
  - behandel fullscreen-exits kort na seek of browser UI-transities eerst als tijdelijk
  - pas pas terug naar lobby als zowel fullscreen weg is als playback echt gestopt is

### P1

- Sync-model duidelijker leader-authoritative maken.
  Waarom:
  - nu lopen `seek`, `syncTime`, `syncSnapshot`, `readyState` en bootstrap-herstel deels door elkaar
  - dat maakt timingbugs moeilijker te debuggen
  Aanpak:
  - definieer per actie een eigenaar:
    `leader heartbeat`, `leader seek commit`, `manual resync`, `bootstrap`
  - voeg correlation ids toe aan socket-events

- Meer gerichte mobile sync smoke-tests toevoegen.
  Waarom:
  - bestaande tests dekken veel UI af, maar nog niet het echte probleemgeval: seeken op telefoon met tweede device in dezelfde sessie
  Aanpak:
  - voeg tests toe voor:
    - twee mobiele clients
    - seek tijdens fullscreen/pseudo-fullscreen
    - seek in `data-saver` mode
    - seek gevolgd door `waiting/stalled`

- `player.js` verder opdelen.
  Waarom:
  - de file combineert sync, fullscreen, subtitles, media session, lobby, diagnostics en UI-state
  - regressies rond seek en mobiel gedrag zijn daardoor lastig geïsoleerd op te lossen
  Aanpak:
  - splits minimaal in:
    - `sync-session`
    - `mobile-viewing`
    - `media-source`
    - `subtitle-state`
    - `player-ui`

- Diagnostics uitbreiden met een seek-timeline.
  Waarom:
  - voor dit type bug wil je direct zien:
    `local seek -> remote seek -> waiting -> snapshot -> heartbeat -> fullscreenchange`
  Aanpak:
  - log per seek:
    - `seekId`
    - bronapparaat
    - playback mode
    - drift voor/na correctie
    - aantal extra snapshots

### P2

- Server-state compacter en explicieter modelleren.
  Waarom:
  - `roomStates`, `roomLeaders`, `sharedRooms` en pending actions werken, maar de room lifecycle zit verspreid
  Aanpak:
  - maak een centrale room/session helper met vaste methodes voor:
    - join
    - leader handoff
    - snapshot update
    - pending action cleanup

- Zoek/homepage en player meer dezelfde producttaal laten spreken.
  Waarom:
  - de app voelt functioneel sterk, maar de overgang van library naar sessieflow is nog best technisch
  Aanpak:
  - maak terminology consistenter:
    - room
    - partner
    - get ready
    - start together
  - laat diagnostics/support-acties beter aansluiten op wat een gewone gebruiker ziet

### Analyse huidig issue: flicker bij doorspoelen op telefoon

Waarschijnlijke hoofdoorzaak in de huidige flow:

1. Een device doet lokaal een seek.
2. De player stuurt direct een `seek` naar de andere client.
3. De seeker plant daarna vaak ook nog een extra `requestSyncSnapshot` in.
4. De leader plant bovenop de seek nog een stabiliserende `syncSnapshot`.
5. Als mobiel tijdens dat moment `waiting` of `stalled` vuurt, komt daar nog een extra recovery-sync bovenop.

Gevolg:

- hetzelfde seek-moment kan 2 tot 4 correcties na elkaar veroorzaken
- op mobiel zie je dat als flicker, korte terug/sprong of een seek die niet "blijft staan"

Aanbevolen fix-volgorde:

1. Extra follower `requestSyncSnapshot` na seek tijdelijk uitschakelen of alleen na mislukte settle.
2. `waiting/stalled` negeren binnen een korte post-seek cooldown.
3. `syncSnapshot` threshold rond seek minder streng maken dan de huidige ultrakleine correctie.
4. Daarna pas opnieuw mobiele sync-tests draaien met twee clients.
