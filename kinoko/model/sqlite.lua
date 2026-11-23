-- Variant: SQLite. What may go wrong for a while, then stops.
-- The API killed and started again (crash recovery of the WAL file):
fault { down = "app" }
-- The clients lose the API: an answer can be lost after the API did the work.
fault { cut = { "client", "app" } }

-- The database is a local file, so no fault here can make a request fail inside the
-- API. A 5xx answer is then the API's own error (for example a lock it did not wait for).
local function no_server_error(asked, answer)
  if answer == nil or answer.err ~= nil then return true end
  return string.find(answer.result.stdout, "http=5", 1, true) == nil
end
reply("work", "work: no server error on SQLite", no_server_error)
reply("create", "create: no server error on SQLite", no_server_error)
reply("replay", "replay: no server error on SQLite", no_server_error)
reply("cancel", "cancel: no server error on SQLite", no_server_error)
reply("sweep", "sweep: no server error on SQLite", no_server_error)
