
---

## `stappenplan.md`

```markdown
# Stappenplan TogetherVideo App

Dit stappenplan leidt je duidelijk en gefaseerd door de bouw van de Kijk-samen App. Elke stap kan afzonderlijk worden getest en afgerond.

---

## Fase 1: Basis webserver & videolijst

- [ ] Zet een Node.js-server op met Express.
- [ ] Maak een route (`/api/videos`) die automatisch bestanden uit de `videos/`-map laadt en weergeeft.
- [ ] Gebruik FFmpeg/ffprobe om lengte van video's toe te voegen aan bestandsinformatie.
- [ ] Maak een simpele HTML-pagina die de lijst toont.

**Test:** Open `localhost:8000` en controleer of video's correct verschijnen.

---

## Fase 2: Videostreaming in browser

- [ ] Configureer Express om video's via HTTP te streamen (met Range-header ondersteuning).
- [ ] Maak een pagina met HTML5 `<video>` element voor afspelen van video's.
- [ ] Zorg dat video's laden, afspelen en doorspoelen.

**Test:** Kies een video uit de lijst en zorg dat deze correct afspeelt en doorspoelen werkt.

---

## Fase 3: Real-time synchronisatie (WebSockets)

- [ ] Voeg Socket.IO toe aan server en frontend.
- [ ] Maak Socket.IO events voor `play`, `pause` en `seek`.
- [ ] Synchroniseer deze events realtime tussen twee verbonden clients.

**Test:** Verbind twee browsers lokaal en controleer synchroon afspelen/pauzeren/doorspoelen.

---

## Fase 4: Voortgang opslaan en laden

- [ ] Maak unieke identifiers voor gebruikers (host en gast).
- [ ] Sla bij elke pauze of sluiting huidige tijdstip op in een JSON-bestand.
- [ ] Bij herladen van de video, laad opgeslagen voortgang automatisch.

**Test:** Pauzeer een video, sluit browser en controleer of voortgang wordt hervat.

---

## Fase 5: Externe toegang (via ngrok)

- [ ] Installeer en configureer ngrok voor tijdelijke externe toegang.
- [ ] Maak uitnodigingslinks met unieke tokens (optioneel, voor extra veiligheid).
- [ ] Zorg dat gasten eenvoudig verbinding kunnen maken via gedeelde ngrok-link.

**Test:** Open ngrok-tunnel en laat een tweede gebruiker extern verbinden. Test streaming en synchronisatie via internet.

---

## Fase 6: Veiligheid en afronding

- [ ] Beperk server toegang tot alleen `videos/` map en onderliggende mappen.
- [ ] Beperk maximaal aantal gebruikers tot vier.
- [ ] Voeg minimale authenticatie toe (unieke link/token).
- [ ] Maak eenvoudige en duidelijke documentatie (README aanvullen indien nodig).

**Test:** Controleer of veiligheidsmaatregelen werken, zoals authenticatie en beperkte toegang.

---