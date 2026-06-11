import { type ReactNode, useMemo, useState } from "react";
import { getTranscript } from "../api.ts";
import { JsonView } from "../components/JsonView.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { usePoll } from "../hooks.ts";
import {
  type ParsedMessage,
  type ProviderMetaBlock,
  parseSessionLogs,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../logs-parser/index.ts";
import "./transcript.css";

const THINKING_COLLAPSE = 400;
const RESULT_CLIP = 2_000;

interface MetaLine {
  key: string;
  block: ProviderMetaBlock;
}

type Entry =
  | { kind: "divider"; key: string; iteration: number }
  | { kind: "msg"; key: string; msg: ParsedMessage }
  | { kind: "metas"; key: string; lines: MetaLine[] };

export default function Transcript(props: { attemptId: string; live?: boolean }): ReactNode {
  const { data, error } = usePoll(() => getTranscript(props.attemptId), props.live ? 5000 : null, [
    props.attemptId,
  ]);

  const messages = useMemo(
    () => (data?.source === "raw-session-logs" && data.rows ? parseSessionLogs(data.rows) : []),
    [data],
  );

  // Pair tool results to their calls across ALL messages by tool_use_id.
  const pairing = useMemo(() => {
    const resultById = new Map<string, ToolResultBlock>();
    const callIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result") resultById.set(block.tool_use_id, block);
        else if (block.type === "tool_use") callIds.add(block.id);
      }
    }
    return { resultById, callIds };
  }, [messages]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    let prevIteration: number | null = null;
    messages.forEach((msg, i) => {
      if (prevIteration !== null && msg.iteration !== prevIteration) {
        out.push({ kind: "divider", key: `div-${i}`, iteration: msg.iteration });
      }
      prevIteration = msg.iteration;
      const metas = msg.content.filter((b): b is ProviderMetaBlock => b.type === "provider_meta");
      if (metas.length > 0 && metas.length === msg.content.length) {
        // meta-only message — consecutive ones collapse into one group
        const lines = metas.map((block, j) => ({ key: `m-${i}-${j}`, block }));
        const last = out[out.length - 1];
        if (last && last.kind === "metas") last.lines.push(...lines);
        else out.push({ kind: "metas", key: `metas-${i}`, lines });
      } else {
        out.push({ kind: "msg", key: `msg-${i}`, msg });
      }
    });
    return out;
  }, [messages]);

  if (!data) {
    return (
      <div className="transcript">
        {error ? (
          <div className="t-empty dim">transcript failed to load: {error}</div>
        ) : (
          <div className="t-empty">
            <Spinner label="loading transcript…" />
          </div>
        )}
      </div>
    );
  }

  if (data.source === null) {
    return (
      <div className="transcript">
        <div className="t-empty dim">no transcript captured</div>
        {props.live ? <Footer /> : null}
      </div>
    );
  }

  if (data.source === "transcript") {
    return (
      <div className="transcript">
        <div className="t-caption">
          {data.harness ?? "unknown"} · legacy flat transcript (older run)
        </div>
        <pre className="t-flat">{data.text ?? ""}</pre>
        {props.live ? <Footer /> : null}
      </div>
    );
  }

  const rowCount = data.rows?.length ?? 0;
  return (
    <div className="transcript">
      <div className="t-caption">
        {data.harness ?? "unknown"} · {rowCount} events · {messages.length} messages
      </div>
      {rowCount === 0 ? <div className="t-empty dim">no events yet</div> : null}
      {entries.map((entry) => {
        if (entry.kind === "divider") {
          return (
            <div className="t-divider" key={entry.key}>
              — iteration {entry.iteration} —
            </div>
          );
        }
        if (entry.kind === "metas") return <MetaGroup lines={entry.lines} key={entry.key} />;
        return (
          <MessageCard
            msg={entry.msg}
            resultById={pairing.resultById}
            callIds={pairing.callIds}
            key={entry.key}
          />
        );
      })}
      {props.live ? <Footer /> : null}
    </div>
  );
}

function Footer(): ReactNode {
  return (
    <div className="t-footer">
      <Spinner label="streaming…" />
    </div>
  );
}

function MessageCard(props: {
  msg: ParsedMessage;
  resultById: Map<string, ToolResultBlock>;
  callIds: Set<string>;
}): ReactNode {
  const { msg, resultById, callIds } = props;
  const rendered: ReactNode[] = [];
  // blocks never reorder within a parsed message — positional keys are stable
  let pos = 0;
  for (const block of msg.content) {
    const key = `b${pos++}`;
    switch (block.type) {
      case "text": {
        if (block.text) {
          rendered.push(
            <div className="t-text" key={key}>
              {block.text}
            </div>,
          );
        }
        break;
      }
      case "thinking": {
        rendered.push(<Thinking text={block.thinking} key={key} />);
        break;
      }
      case "tool_use": {
        rendered.push(
          <ToolCard call={block} result={resultById.get(block.id) ?? null} key={key} />,
        );
        break;
      }
      case "tool_result": {
        // paired results render inline under their call; only orphans render standalone
        if (!callIds.has(block.tool_use_id)) {
          rendered.push(<OrphanResult result={block} key={key} />);
        }
        break;
      }
      case "provider_meta": {
        rendered.push(<MetaLineView block={block} key={key} />);
        break;
      }
    }
  }
  if (rendered.length === 0) return null; // e.g. a message holding only paired tool results
  return (
    <div className={`t-msg t-${msg.role}`}>
      <div className="t-role">{msg.role}</div>
      {rendered}
    </div>
  );
}

function Thinking(props: { text: string }): ReactNode {
  const collapsible = props.text.length > THINKING_COLLAPSE;
  const [open, setOpen] = useState(!collapsible);
  if (!open) {
    return (
      <button type="button" className="t-toggle" onClick={() => setOpen(true)}>
        ▸ thinking ({props.text.length} chars)
      </button>
    );
  }
  return (
    <div className="t-thinking-wrap">
      {collapsible ? (
        <button type="button" className="t-toggle" onClick={() => setOpen(false)}>
          ▾ thinking ({props.text.length} chars)
        </button>
      ) : null}
      <div className="t-thinking">{props.text}</div>
    </div>
  );
}

function ToolCard(props: { call: ToolUseBlock; result: ToolResultBlock | null }): ReactNode {
  const { call, result } = props;
  return (
    <div className={`t-tool${result?.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">⚙ {call.name}</div>
      <JsonView value={call.input} collapseDepth={1} />
      {result ? <ResultBody result={result} /> : null}
    </div>
  );
}

function OrphanResult(props: { result: ToolResultBlock }): ReactNode {
  return (
    <div className={`t-tool${props.result.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">
        ⚙ tool result <span className="dim">{props.result.tool_use_id}</span>
      </div>
      <ResultBody result={props.result} />
    </div>
  );
}

function ResultBody(props: { result: ToolResultBlock }): ReactNode {
  const { result } = props;
  const [full, setFull] = useState(false);
  const clipped = !full && result.content.length > RESULT_CLIP;
  if (!result.content) {
    return <div className="t-tool-result dim">(empty result)</div>;
  }
  return (
    <div className={`t-tool-result${result.isError ? " error" : ""}`}>
      <pre>{clipped ? `${result.content.slice(0, RESULT_CLIP)}…` : result.content}</pre>
      {clipped ? (
        <button type="button" className="t-toggle" onClick={() => setFull(true)}>
          show all ({result.content.length} chars)
        </button>
      ) : null}
    </div>
  );
}

function MetaLineView(props: { block: ProviderMetaBlock }): ReactNode {
  const { block } = props;
  const [open, setOpen] = useState(false);
  const dataType = typeof block.data.type === "string" ? block.data.type : "";
  return (
    <div className="t-meta">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {block.kind}
        {dataType ? `: ${dataType}` : ""}
      </button>
      {open ? <JsonView value={block.data} collapseDepth={1} /> : null}
    </div>
  );
}

function MetaGroup(props: { lines: MetaLine[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.lines.length === 1) return <MetaLineView block={props.lines[0].block} />;
  return (
    <div className="t-meta-group">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {props.lines.length} internal events
      </button>
      {open ? props.lines.map((l) => <MetaLineView block={l.block} key={l.key} />) : null}
    </div>
  );
}
