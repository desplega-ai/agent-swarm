import { Link } from "react-router-dom";
import type { StatusAutomation } from "../../api/types";
import { automationDisplayName, automationFixLabel } from "../../lib/automation-setup";

export function AutomationSetupRows({ automations }: { automations: StatusAutomation[] }) {
  return (
    <ul className="mt-1 space-y-1 sm:mt-0">
      {automations.map((automation) => (
        <li
          key={`${automation.kind}:${automation.id}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span className="font-medium text-foreground">{automationDisplayName(automation)}</span>
          <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
            {automation.fixes.map((fix) => (
              <li key={`${fix.type}:${fix.key}`}>
                <Link to={fix.url} className="text-primary text-sm hover:underline">
                  {automationFixLabel(fix)}
                </Link>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
