-- Backfill seed users + their external identities.
-- Safe to re-run (INSERT OR IGNORE on both stages).
--
-- Stage 1: insert the canonical user rows (no identity columns — migration
--          064 dropped them).
-- Stage 2: insert each platform identity into user_external_ids
--          (kind, externalId, userId) PK.
--
-- Run manually after deploying migration 064:
--   sqlite3 agent-swarm-db.sqlite < scripts/backfill-seed-users.sql

-- ---------------------------------------------------------------------------
-- Stage 1: canonical users
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone)
VALUES (
  'ee27960e3ce6255dcbc050efd28559d2',
  'Taras',
  't@desplega.ai',
  'co-founder, CTO',
  'Full name: Taras Yarema. CTO & Co-Founder of desplega.ai (Jan 2026–present). Based in Barcelona. Education: Bachelor''s in Mathematics, Universitat de Barcelona (2021); Bachelor''s in Economics, Universitat Oberta de Catalunya. Career: Capchase (4 years) — SWE (2020–2021, integration automation, international payments), Senior SWE & TL (2021–2024, Capchase Pay TL, payments infrastructure, data platform, tech community lead). SheetSQL founder (2024, data platform for non-techies, discontinued). SOLO Staff Engineer & TL (Oct 2024–Jun 2025, data ingestion/processing). Stealth AI startup in QA space (Jun 2025–Jan 2026). Earlier: PremiumGuest SWE (2020, PHP/MySQL/AWS/Python/Go), PartyAdvisor backend dev (2019, Django/Flask/AWS/Docker), HackUPC game dev (2019). Skills: AI, PostgreSQL, React.js. Languages: Ukrainian (native), Russian, Spanish (native), Catalan (native), English (professional). Hackathon awards: 2nd Place HackUPC 2016, Finalist HackUPC Fall 2017, Best Game HackUPC 2018, Honorable mention JacobsHack! 2018, Finalist CopenHacks 2019. Certification: Capitán de Yate. LinkedIn: linkedin.com/in/tarasyarema',
  '[]',
  'slack',
  NULL
);

INSERT OR IGNORE INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone)
VALUES (
  'e1b7227eb02da20c30a1646f1bec1096',
  'Eze',
  'e@desplega.ai',
  'co-founder, CEO',
  'Full name: Ezequiel Cura. CEO & Co-Founder of desplega.ai (Jan 2026–present). Based in Barcelona. Education: Licenciado in Ciencias de la Computación, Universidad de Buenos Aires (2004–2010). Career: 7+ years at Google — Google Photos & Picker (SWE II/III, 2012–2014), Research/event perception (SWE III, 2014–2016, Bay Area), Google Pay (Senior SWE/TL, 2016–2018, incl. Japan launch), sumUX (Staff SWE, 2019). VP Engineering at Badi (2019–2021, 30+ reports across Mobile, Web, DevOps, QA, Data). Capchase (4.5 years): VP Technology (2021–2023), SVP Technology (2023–2025, led Engineering, Data, ML/AI, Growth, HR, Product, UX), Advisor (Jul–Sep 2025). Stealth AI Startup builder (Jul–Nov 2025). Earlier: Park Assist LLC (NYC, embedded software for 2000+ device networks, 2011–2012), INRIA research intern (image processing/ML, 2010), teaching assistant at UBA, researcher in computer vision, founded Apareser (web/desktop apps, 2005–2008). Skills: Linux, ML, Python. Patent: intelligent imaging for parking management. LinkedIn: linkedin.com/in/ecura',
  '[]',
  'slack',
  NULL
);

-- ---------------------------------------------------------------------------
-- Stage 2: external identity mappings (kind, externalId, userId)
-- ---------------------------------------------------------------------------

-- Taras
INSERT OR IGNORE INTO user_external_ids (userId, kind, externalId) VALUES
  ('ee27960e3ce6255dcbc050efd28559d2', 'slack',  'U08NR6QD6CS'),
  ('ee27960e3ce6255dcbc050efd28559d2', 'linear', '1eb14760-2029-430f-862a-a070e5e4d213'),
  ('ee27960e3ce6255dcbc050efd28559d2', 'github', 'tarasyarema');

-- Eze
INSERT OR IGNORE INTO user_external_ids (userId, kind, externalId) VALUES
  ('e1b7227eb02da20c30a1646f1bec1096', 'slack',  'U08NY4B5R2M'),
  ('e1b7227eb02da20c30a1646f1bec1096', 'linear', '0a4ac2b3-70d0-4595-a93c-debeb1839b50'),
  ('e1b7227eb02da20c30a1646f1bec1096', 'github', 'harlequinetcie');
