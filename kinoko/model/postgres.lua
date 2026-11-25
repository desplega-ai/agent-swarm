-- Variant: PostgreSQL. What may go wrong for a while, then stops.
-- The API or the database killed and started again:
fault { down = "app" }
fault { down = "postgres" }
-- Nothing passes between the API and the database:
fault { cut = { "app", "postgres" } }
-- What the API sends arrives late: to the database only, then to everyone.
fault { slow = "app", to = "postgres", ms = 200 }
fault { slow = "app", ms = 200 }
-- The clients lose the API: an answer can be lost after the API did the work.
fault { cut = { "client", "app" } }
