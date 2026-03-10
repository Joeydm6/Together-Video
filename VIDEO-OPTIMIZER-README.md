# 🎬 Advanced Video Optimizer

Een krachtige video optimizer die **kwaliteit behoudt** terwijl het compatibility voor streaming verbetert.

## 🆚 Waarom deze nieuwe optimizer?

De oude optimizer had grote problemen:
- **Grijze, doffe video's** door te agressieve compressie
- **Slechte audio kwaliteit** (128k was veel te laag)
- **Te strikte bitrate limieten** (3M was veel te weinig)
- **Geen keuze in kwaliteitsinstellingen**

## ✨ Nieuwe Features

### 🎥 5 Kwaliteitspresets
| Preset | CRF | Audio | Gebruik |
|--------|-----|-------|---------|
| **Ultra** | 16 | 320k | Perfect quality, grote bestanden |
| **High** | 18 | 256k | **AANBEVOLEN** - Hoge kwaliteit voor lokaal streamen |
| **Balanced** | 20 | 192k | Goede balans kwaliteit/grootte |
| **Streaming** | 22 | 160k | Internet streaming |
| **Mobile** | 24 | 128k | Kleine bestanden voor mobiel |

### 📐 Resolutie Opties
- **Keep Original** - Geen scaling (aanbevolen)
- **4K** (2160p)
- **1440p** (2K)
- **1080p** (Full HD)
- **720p** (HD)
- **480p** (SD)

### 🔄 Two-Pass Encoding
- **Single-pass**: Snel, goede kwaliteit
- **Two-pass**: Langzamer, perfecte kwaliteit

## 🚀 Hoe te gebruiken

### Enkele video optimaliseren
```bash
node advanced-video-optimizer.js "pad/naar/video.mkv"
```

### Hele map optimaliseren (batch)
```bash
node batch-video-optimizer.js "E:\Media\Series\My Show"
```

## 📊 Interactieve Menu's

De tools zijn volledig interactief - je wordt gevraagd naar:

1. **Kwaliteitspreset** (aanbeveling: HIGH)
2. **Doelresolutie** (aanbeveling: Keep Original)  
3. **Two-pass encoding?** (aanbeveling: Nee voor snelheid, Ja voor perfecte kwaliteit)
4. **Recursive processing?** (voor batch - aanbeveling: Ja)

## 🛡️ Veiligheid

- **Originele bestanden worden bewaard** in `originals/` map
- **Geen data verlies** - je kunt altijd terug
- **Slimme detectie** - slaat al geoptimaliseerde bestanden over

## 🔧 Technische Verbeteringen

### Audio Kwaliteit
- **48kHz sample rate** (was 44.1kHz)
- **Veel hogere bitrates** (160k-320k vs 128k)
- **Stereo optimalisatie**

### Video Kwaliteit  
- **Lagere CRF waarden** (16-24 vs 23)
- **Profile: high** (was main) voor betere compressie
- **Level 4.0** (was 3.1) voor hogere kwaliteit
- **Tune: film** voor video content
- **Betere keyframe intervals**

### Bitrate Management
- **Geen strikte limieten** voor Ultra/High presets
- **Realistische limieten** voor streaming presets
- **Grotere buffers** voor stabiele kwaliteit

## 📈 Resultaten

### Voor (oude optimizer):
```
CRF: 23 (te hoog)
Maxrate: 3M (veel te laag)
Audio: 128k (slechte kwaliteit)
Result: Grauwe, doffe video's
```

### Na (nieuwe optimizer HIGH preset):
```
CRF: 18 (uitstekende kwaliteit)
Maxrate: 8M (realistische limiet)
Audio: 256k (hoge kwaliteit)
Result: Heldere, kleurrijke video's
```

## 🎯 Aanbevelingen per Situatie

### 🏠 Lokaal Streamen (2 gebruikers)
**Preset**: `high` of `ultra`
**Resolutie**: Keep Original
**Two-pass**: Optioneel

### 🌐 Internet Streaming
**Preset**: `streaming` 
**Resolutie**: 1080p of lager
**Two-pass**: Ja voor beste resultaat

### 📱 Mobiele Apparaten
**Preset**: `mobile`
**Resolutie**: 720p
**Two-pass**: Nee (snelheid)

## 🔄 Migratie van Oude Optimizer

Als je al bestanden hebt geoptimaliseerd met de oude tool:

1. **Originelen terugzetten** uit `oud/` map
2. **Nieuwe optimizer draaien** met HIGH preset
3. **Kwaliteit vergelijken** - het verschil is enorm!

## ⚡ Performance Tips

- **SSD storage** helpt enorm bij encoding snelheid
- **Meer CPU cores** = snellere encoding (preset 'slow' vs 'fast')
- **RAM**: 8GB+ aanbevolen voor grote bestanden
- **Two-pass encoding** duurt 2x zo lang maar geeft perfecte resultaten

## 🔍 Troubleshooting

### "FFmpeg not found"
Zorg dat FFmpeg correct geïnstalleerd is in:
```
C:\Users\Joey\Documents\Code\TogetherVideo\FFMPEG\bin\
```

### "Already optimized, skipping"
De tool detecteert dat een bestand al geoptimaliseerd is (origineel in `originals/` map bestaat).

### Encoding lijkt vast te lopen
Dit is normaal - video encoding kan lang duren, vooral met 'slow' presets.

## 🎉 Eindresultaat

- **Kristalheldere video's** zonder het grijze effect
- **Uitstekende audio kwaliteit**
- **Snelle streaming** zonder transcoding  
- **Maximaal 2 gebruikers** kunnen soepel streamen
- **Compatibel met alle devices**

De nieuwe optimizer lost alle problemen van de oude versie op en geeft je de controle over kwaliteit vs bestandsgrootte! 