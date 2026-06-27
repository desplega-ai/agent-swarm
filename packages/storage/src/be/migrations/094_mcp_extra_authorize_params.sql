-- Extra OAuth authorize-request params, applied at authorize time only.
-- JSON object string of flat string->string pairs, e.g. {"access_type":"offline","prompt":"consent"}.
-- NULL (default) => authorize URL is unchanged from today. Provider-agnostic.
ALTER TABLE mcp_servers ADD COLUMN extraAuthorizeParams TEXT;
