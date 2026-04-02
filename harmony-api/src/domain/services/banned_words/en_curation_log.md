# English Word List Curation Log

Source: `raw/merged_en.txt` (2,755 words)

## Output

| Category | File | Count |
|----------|------|-------|
| Abuse (server-enforced) | `en_abuse.txt` | 576 |
| Profanity (client-toggleable) | `en_profanity.txt` | 1,970 |
| Removed | (not included) | 209 |
| **Total** | | **2,755** |

## Removed Words (209) with Reasoning

### Anatomical / Medical Terms
These are legitimate vocabulary used in medical, educational, and everyday contexts.

| Word | Reason |
|------|--------|
| anus | Anatomical term |
| ejaculation | Medical/biological term |
| enema | Medical procedure |
| erection | Medical/physiological term |
| faeces | Medical term (British spelling of feces) |
| fecal | Medical adjective |
| foreskin | Anatomical term |
| genital, genitals | Anatomical terms |
| glans | Anatomical term |
| gonad, gonads | Anatomical term |
| hymen | Anatomical term |
| labia | Anatomical term |
| nipple, nipples | Anatomical term |
| ovum, ovums | Biological term |
| teste, testee, testes, testical, testicle, testicles, testis | Anatomical terms |
| syphilis | Medical condition |
| gonorrehea | Medical condition (misspelled) |
| herp, herpes, herpy | Medical condition / too vague |

### Legitimate English Words (Non-Offensive Primary Meaning)
These words have common non-offensive uses that would cause excessive false positives.

| Word | Reason |
|------|--------|
| abuse | Common word ("child abuse prevention", "abuse of power") |
| babes | Common term of endearment |
| blacks | Common adjective/noun (colors, demographics) |
| blackman | Name / common compound |
| bombers | Common word (aircraft, sports teams) |
| bootee | Baby shoe |
| boozer | Casual word for bar/pub (British) |
| buffies | Too vague |
| chav | British slang, too culturally vague for global filter |
| cockfight | Legitimate (if controversial) activity term |
| coital, coitus | Medical/academic terms |
| condom | Health product, not profanity |
| copulate | Academic/scientific term |
| defecate | Medical term |
| doggie | Common pet term ("doggie bag") |
| dudette | Informal but non-offensive |
| escort | Common word (security escort, etc.) |
| eunuch | Historical/anatomical term |
| excrement | Medical/formal term |
| geezer | British slang for "man", non-offensive |
| grope | Common verb (groping in the dark) |
| hells | Too common ("hells yeah", "hells bells") |
| hijacking | Common word |
| honkers | Too vague (car horns, etc.) |
| hooch | Slang for alcohol, too common |
| hork | Too vague |
| hot chick | Too common/vague |
| huge fat, hugefat | Too vague, body-shaming but not profanity |
| leper | Historical/medical term |
| libido | Medical/psychological term |
| lingerie | (kept in profanity) |
| lucifer | Name (matches, Morningstar) |
| mams | Too vague (variant of "mams/moms") |
| naked | Too common |
| ninny | Mild insult, too archaic |
| nude, nudie, nudies, nudity, nudger | Too common/legitimate |
| prig | Archaic mild insult |
| sanchez | Common surname |
| scallywag | Playful term |
| scantily | Common adverb |
| seduce | Common word |
| sex, sexed, sexing, sexual, sexually, sexy | Too fundamental/common |
| squirting | Too common (water squirting, etc.) |
| stoned, stoner | Drug culture slang but too common |
| tawdry | Common adjective |
| toots | Term of endearment |
| torture, tortur | Common words |
| trots | Common word (horse trots) |
| vixen | Common word (female fox, name) |
| welcher | Common word (one who welches) |
| wench | Archaic, used in gaming/fantasy |

### Drug-Related Terms (Not Profanity)
Drug terms are not appropriate for a profanity filter. They belong in separate drug-related moderation if needed.

| Word | Reason |
|------|--------|
| cocain, cocaine | Drug name |
| crackcocain, crackpipe | Drug paraphernalia |
| cyalis | Misspelled medication name |
| extacy, extasy | Drug name (misspelled) |
| fourtwenty | Cannabis culture reference (420) |
| ganja | Cannabis synonym |
| heroin | Drug name |
| lsd | Drug name |
| marijuana | Drug name |
| pcp | Drug name |
| peyote | Drug name / culturally significant plant |
| reefer | (kept in profanity as it's also used as mild profanity) |
| valium | Medication name |
| xtc | Drug name abbreviation |

### Names / Proper Nouns
Names of people, places, or organizations that would cause false positives.

| Word | Reason |
|------|--------|
| azazel | Mythological/religious figure |
| carruth | Surname |
| dahmer | Surname |
| ekrem | Common Turkish name |
| fatah | Political organization |
| hamas | Political organization |
| israels | Plural of Israel (name) |
| jebus | Historical place name / joke name |
| jihad | Arabic word with primary religious meaning ("struggle") |
| mickeyfinn | Name-based term |
| moslem | Alternate spelling of Muslim (not a slur per se) |
| nambla | Organization acronym |
| noonan | Surname |
| osama, usama | Names |
| rautenberg | Surname |
| schaffer | Surname |
| yury | Name |

### Non-English Words / Foreign Language Terms
Words from other languages that are not English profanity.

| Word | Reason |
|------|--------|
| chinga | Spanish verb, not English |
| esqua | Non-English |
| exkwew | Non-English / unclear |
| floo | Non-English / too vague |
| flydie, flydye | Non-English / unclear |
| freex | Non-English / unclear |
| geni | Non-English |
| gonzagas | Surname / place name |
| grostulation | Non-standard word |
| helvete | Swedish/Norwegian for "hell" |
| hui | Common Chinese/other language word |
| kanker | Dutch word for cancer (not English) |
| kawk | Non-English variant |
| kimchis | Korean food |
| kyrpa | Finnish, not English |
| l3i\+ch | Malformed/unclear entry |
| lipshits, lipshitz | Surnames (Ashkenazi) |
| maricón | Spanish slur (non-accent `maricon` kept in profanity) |
| mideast | Common geographic term |
| mierda | Spanish, not English |
| nepesaurio | Non-English |
| payo | Non-English |
| penthouse | Common word (building/magazine) |
| perse | Finnish / common English word meaning "by itself" |
| shinola | Brand name |
| taff | River name in Wales |
| uzi | Firearm brand name |
| wetb | Truncated/unclear |
| whit | Common word ("not a whit") |

### Legitimate Words That Resemble Slurs
Words with unfortunate resemblance to slurs but are legitimate English.

| Word | Reason |
|------|--------|
| niggard, niggarded, niggarding, niggardliness, niggardlinesss, niggardly, niggards | Legitimate English words meaning "miserly" (Old Norse origin, unrelated to racial slur) |
| niggle, niggled, niggles, nigglings | Legitimate English words meaning "to cause slight annoyance" |
| sniggered, sniggering, sniggers | British English for "snickered/snickering" |
| nittit | Too vague / unclear |

### Miscellaneous
| Word | Reason |
|------|--------|
| acrotomophilia, dendrophilia | Obscure medical/psychological terms |
| bastinado | Historical torture method, too obscure |
| bomd | Misspelling, unclear |
| burr head, burr heads, burrhead, burrheads | Hair type description, too vague |
| cra5h | Misspelling of "crash" |
| deth | Misspelling of "death" |
| dragqueen, dragqween | Describes drag performers (not a slur) |
| ero | Too short/vague |
| evl | Too short/vague |
| girl on, girl on top, girls gone wild, goo girl | Too vague or brand names |
| nastt | Misspelling, unclear |
| necro | Prefix, too vague |
| one guy, one jar | Too vague individually |
| orga | Too short/vague |
| orgasim; | Malformed entry (has semicolon) |
| rere | Too vague |
| ruski, russki, russkie | Informal terms for Russian, milder than slurs (borderline) |
| sadis, sadom | Truncated/misspelled |
| stagg | Common surname / too vague |
| souse, soused | Drinking terms, too archaic |
| vgra, vigra | Truncated medication names |
| waysted | Misspelling of "wasted" |

## Classification Principles Applied

1. **Abuse** (server-enforced, always blocked): Racial/ethnic/religious slurs, gender/sexuality-based hate speech, dehumanizing language, white supremacist terminology, and their leet-speak/phonetic variants.

2. **Profanity** (client-toggleable): Standard profanity (fuck, shit, ass, etc.) and all variants, crude sexual terms, common insults, vulgar but non-hateful language, and explicit sexual content terms.

3. **Removed**: Medical/anatomical terms, words with primary non-offensive meanings, drug names (belong in separate moderation), proper nouns/names, non-English words, legitimate English words that happen to resemble slurs, and too-vague/truncated entries.

When in doubt between abuse and profanity, we leaned toward abuse (safety first).
When in doubt between profanity and remove, we leaned toward profanity (better to filter than miss).
