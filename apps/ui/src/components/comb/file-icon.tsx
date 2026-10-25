import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { type FileIconKind, fileIconKind } from "@/lib/comb/file-icons";
import { cn } from "@/lib/utils";

const ICONS: Record<FileIconKind, LucideIcon> = {
  folder: Folder,
  markdown: FileText,
  text: FileText,
  image: FileImage,
  audio: FileMusic,
  video: FilePlay,
  pdf: FileType,
  html: Globe,
  code: FileCode,
  data: FileBraces,
  table: FileSpreadsheet,
  archive: FileArchive,
  file: File,
};

/**
 * A drive entry's icon: one mono shape per kind (`fileIconKind`), muted.
 * Decorative: the name next to it is the label.
 */
export function FileKindIcon({
  name,
  isFolder,
  open = false,
  className,
}: {
  name: string;
  isFolder: boolean;
  /** An open folder in a tree. */
  open?: boolean;
  className?: string;
}) {
  const kind = fileIconKind(name, isFolder);
  const Icon = kind === "folder" && open ? FolderOpen : ICONS[kind];
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}
