import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WebClient } from "@slack/web-api";

/**
 * Maximum file size for uploads (1 GB)
 */
export const MAX_FILE_SIZE = 1073741824;

/**
 * Directory that `slack-download-file` saves inside when there is no task.
 */
export const DOWNLOAD_ROOT = "/workspace/shared/downloads";

/**
 * Default download directory for Slack files
 */
export const DEFAULT_DOWNLOAD_DIR = `${DOWNLOAD_ROOT}/${process.env.AGENT_ID || "default"}/slack`;

/**
 * File object from Slack API (partial, commonly used fields)
 */
export interface SlackFile {
  id: string;
  name: string;
  title?: string;
  mimetype: string;
  filetype: string;
  /** `slack_audio` on a voice clip recorded in Slack. */
  subtype?: string;
  size: number;
  url_private: string;
  url_private_download: string;
  thumb_64?: string;
  thumb_80?: string;
  thumb_160?: string;
  thumb_360?: string;
  thumb_480?: string;
  user?: string;
  created?: number;
}

/**
 * Options for uploading a file to Slack
 */
export interface UploadFileOptions {
  /** Path to the file to upload, or a Buffer */
  file: string | Buffer;
  /** Name to give the file in Slack */
  filename: string;
  /** Channel ID to share the file to */
  channelId?: string;
  /** Thread timestamp to reply in a thread */
  threadTs?: string;
  /** Initial comment/message to post with the file */
  initialComment?: string;
  /** Title for the file */
  title?: string;
}

/**
 * Result from uploading a file
 */
export interface UploadFileResult {
  success: boolean;
  fileId?: string;
  error?: string;
}

/**
 * Options for downloading a file from Slack
 */
export interface DownloadFileOptions {
  /** The file object or URL to download from */
  file: SlackFile | string;
  /** Where to save the file. If a directory, uses the original filename. A relative path resolves from `root`. */
  savePath: string;
  /** Directory the saved file must stay inside. */
  root: string;
  /** Bot token for authorization */
  token: string;
}

/**
 * Result from downloading a file
 */
export interface DownloadFileResult {
  success: boolean;
  savedPath?: string;
  error?: string;
}

/**
 * Upload a file to Slack using the filesUploadV2 method.
 *
 * @param client - Slack WebClient instance
 * @param options - Upload options
 * @returns Upload result with file ID or error
 */
export async function uploadFile(
  client: WebClient,
  options: UploadFileOptions,
): Promise<UploadFileResult> {
  const { file, filename, channelId, threadTs, initialComment, title } = options;

  try {
    // Check file size for Buffer
    if (Buffer.isBuffer(file) && file.length > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File size ${file.length} bytes exceeds maximum of ${MAX_FILE_SIZE} bytes (1 GB)`,
      };
    }

    // Check file size for path (using stat)
    if (typeof file === "string") {
      const bunFile = Bun.file(file);
      const size = bunFile.size;
      if (size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File size ${size} bytes exceeds maximum of ${MAX_FILE_SIZE} bytes (1 GB)`,
        };
      }
    }

    // Build upload arguments dynamically to handle optional fields
    // biome-ignore lint/suspicious/noExplicitAny: Slack SDK types are complex with many optional fields
    const uploadArgs: Record<string, any> = {
      file,
      filename,
      title: title || filename,
    };

    // Only include channel_id if provided (required for sharing)
    if (channelId) {
      uploadArgs.channel_id = channelId;
      if (threadTs) {
        uploadArgs.thread_ts = threadTs;
      }
      if (initialComment) {
        uploadArgs.initial_comment = initialComment;
      }
    }

    const result = await client.filesUploadV2(
      uploadArgs as Parameters<typeof client.filesUploadV2>[0],
    );

    // The filesUploadV2 method returns a doubly-nested structure:
    // result.files[0].files[0].id contains the actual file ID
    // See: https://github.com/slackapi/node-slack-sdk/issues/1968
    const uploadedFile = result.files?.[0] as { files?: { id?: string }[] } | undefined;
    const fileId = uploadedFile?.files?.[0]?.id;

    if (!fileId) {
      return {
        success: false,
        error: "Upload succeeded but no file ID returned",
      };
    }

    return {
      success: true,
      fileId,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Download a file from Slack.
 *
 * @param options - Download options including file info, save path, and token
 * @returns Download result with saved path or error
 */
export async function downloadFile(options: DownloadFileOptions): Promise<DownloadFileResult> {
  const { file, savePath, token, root } = options;

  try {
    // Get the download URL
    const downloadUrl = typeof file === "string" ? file : file.url_private_download;

    if (!downloadUrl) {
      return {
        success: false,
        error: "No download URL available for this file",
      };
    }

    // The bot token goes only to Slack's own file hosts.
    if (!isSlackFileUrl(downloadUrl)) {
      return { success: false, error: "The download URL is not a Slack file URL" };
    }

    // Determine final save path
    let finalPath = savePath;
    if (typeof file !== "string" && (savePath.endsWith("/") || !savePath.includes("."))) {
      // savePath is a directory, append the filename
      const name = basename(file.name);
      finalPath = savePath.endsWith("/") ? `${savePath}${name}` : `${savePath}/${name}`;
    }
    finalPath = resolve(root, finalPath);
    if (!isInside(resolve(root), finalPath)) {
      return { success: false, error: `The save path must be inside ${root}` };
    }

    // Ensure directory exists, then check that no symlink leads out of root
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) {
      return { success: false, error: `${root} must not be a symlink` };
    }
    await mkdir(dirname(finalPath), { recursive: true });
    if (!isInside(await realpath(root), await realpath(dirname(finalPath)))) {
      return { success: false, error: `The save path must be inside ${root}` };
    }

    // Download the file using fetch with Authorization header
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP error ${response.status}: ${response.statusText}`,
      };
    }

    // Write to file using streams
    const body = response.body;
    if (!body) {
      return {
        success: false,
        error: "No response body",
      };
    }

    // O_NOFOLLOW: never write through a symlink at the final path.
    const handle = await open(
      finalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
    try {
      for await (const chunk of body) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    return {
      success: true,
      savedPath: finalPath,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/** True when `child` is `parent` itself or a path below it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True for an https URL on a Slack host (`slack.com`, `slack-gov.com` and their
 * subdomains), or on the origin of `SLACK_API_URL` when that override is set.
 */
function isSlackFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const apiUrl = process.env.SLACK_API_URL;
  if (apiUrl && URL.canParse(apiUrl) && new URL(apiUrl).origin === parsed.origin) return true;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return ["slack.com", "slack-gov.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * Check if a file is an image based on mimetype or extension.
 *
 * @param file - File object or mimetype string
 * @returns true if the file is an image
 */
export function isImageFile(file: SlackFile | string): boolean {
  const mimetype = typeof file === "string" ? file : file.mimetype;
  return mimetype.startsWith("image/");
}

/**
 * Get file info from Slack.
 *
 * @param client - Slack WebClient instance
 * @param fileId - The file ID to look up
 * @returns File info or null if not found
 */
export async function getFileInfo(client: WebClient, fileId: string): Promise<SlackFile | null> {
  try {
    const result = await client.files.info({ file: fileId });

    if (!result.file) {
      return null;
    }

    const f = result.file;

    return {
      id: f.id as string,
      name: f.name as string,
      title: f.title as string | undefined,
      mimetype: f.mimetype as string,
      filetype: f.filetype as string,
      size: f.size as number,
      url_private: f.url_private as string,
      url_private_download: f.url_private_download as string,
      thumb_64: f.thumb_64 as string | undefined,
      thumb_80: f.thumb_80 as string | undefined,
      thumb_160: f.thumb_160 as string | undefined,
      thumb_360: f.thumb_360 as string | undefined,
      thumb_480: f.thumb_480 as string | undefined,
      user: f.user as string | undefined,
      created: f.created as number | undefined,
    };
  } catch {
    return null;
  }
}
