import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseConfigList } from "@/lib/configuration-values";

export function ConfigurationMultiselect({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const selected = parseConfigList(value);
  // Keep old/future values visible and removable instead of silently dropping them.
  const choices = [...new Set([...options, ...selected])];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          className="min-w-0 flex-1 justify-start"
        >
          <span className="truncate">
            {selected.length ? selected.join(", ") : "None selected"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choices.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={selected.includes(option)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(
                (checked ? [...selected, option] : selected.filter((item) => item !== option)).join(
                  ",",
                ),
              )
            }
          >
            {option}
            {!options.includes(option) && " (unrecognized)"}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
