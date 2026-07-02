-- Convert the seeded system dashboard user/agent filters from free-text inputs
-- to dynamic select variables. The UI renders select variables with resolved
-- options as searchable comboboxes.

UPDATE metrics
SET
  definition = json_set(
    replace(
      replace(
        replace(
          replace(
            replace(
              definition,
              '? = '''' OR COALESCE(u.id, '''') = ? OR COALESCE(u.name, '''') LIKE ''%'' || ? || ''%''',
              '? = ''all'' OR COALESCE(u.id, '''') = ? OR COALESCE(u.name, '''') LIKE ''%'' || ? || ''%'''
            ),
            '? = '''' OR agentId = ?',
            '? = ''all'' OR agentId = ?'
          ),
          '? = '''' OR sc.agentId = ?',
          '? = ''all'' OR sc.agentId = ?'
        ),
        '? = '''' OR COALESCE(t.agentId, '''') = ?',
        '? = ''all'' OR COALESCE(t.agentId, '''') = ?'
      ),
      '? = '''' OR COALESCE(agentId, '''') = ?',
      '? = ''all'' OR COALESCE(agentId, '''') = ?'
    ),
    '$.variables',
    json('[
      {
        "key": "rangeModifier",
        "label": "Time range",
        "type": "select",
        "defaultValue": "-30 days",
        "options": [
          { "label": "Last 7 days", "value": "-7 days" },
          { "label": "Last 30 days", "value": "-30 days" },
          { "label": "Last 90 days", "value": "-90 days" }
        ]
      },
      {
        "key": "userFilter",
        "label": "Requester",
        "type": "select",
        "defaultValue": "all",
        "optionsQuery": {
          "sql": "SELECT id, label FROM (SELECT ''all'' AS id, ''All requesters'' AS label, 0 AS sort_key UNION ALL SELECT id, COALESCE(NULLIF(name, ''''), email, id) AS label, 1 AS sort_key FROM users WHERE id IS NOT NULL) ORDER BY sort_key, label COLLATE NOCASE",
          "valueKey": "id",
          "labelKey": "label"
        }
      },
      {
        "key": "agentFilter",
        "label": "Agent",
        "type": "select",
        "defaultValue": "all",
        "optionsQuery": {
          "sql": "SELECT id, label FROM (SELECT ''all'' AS id, ''All agents'' AS label, 0 AS sort_key UNION ALL SELECT id, COALESCE(NULLIF(name, ''''), id) AS label, 1 AS sort_key FROM agents WHERE id IS NOT NULL) ORDER BY sort_key, label COLLATE NOCASE",
          "valueKey": "id",
          "labelKey": "label"
        }
      }
    ]')
  ),
  updatedAt = CURRENT_TIMESTAMP
WHERE agentId = 'system'
  AND slug = 'swarm-operations-overview';
