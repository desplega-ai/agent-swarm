/**
 * seccomp filter for the native script harness (`eval-harness.ts`).
 *
 * The harness installs this filter after its own setup and before it imports
 * the user module. From then on, every thread of the harness process (and
 * anything it forks) gets EPERM for the syscalls below. The filter needs no
 * capability: `PR_SET_NO_NEW_PRIVS` makes an unprivileged install legal.
 *
 * Socket syscalls are deliberately allowed. The native SDK reaches the API
 * over TCP from inside the sandbox.
 *
 * Linux only. Callers treat a non-Linux platform, an unknown CPU
 * architecture, or a failed `bun:ffi` load as "not installed".
 */

// struct sock_filter opcodes (linux/bpf_common.h).
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;

// seccomp_data offsets (linux/seccomp.h).
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;

const PR_SET_NO_NEW_PRIVS = 38;
const SECCOMP_SET_MODE_FILTER = 1;
const SECCOMP_FILTER_FLAG_TSYNC = 1;

/** x32 syscalls share AUDIT_ARCH_X86_64 and set this bit in the number. */
const X32_SYSCALL_BIT = 0x40000000;

type ArchTable = {
  auditArch: number;
  seccompSyscall: number;
  denied: Record<string, number>;
  /** Deny every syscall number at or above this value (x32 ABI on x86_64). */
  denyAtOrAbove?: number;
};

export const SECCOMP_ARCH_TABLES: Record<string, ArchTable> = {
  x64: {
    auditArch: 0xc000003e,
    seccompSyscall: 317,
    denied: {
      execve: 59,
      ptrace: 101,
      process_vm_readv: 310,
      process_vm_writev: 311,
      execveat: 322,
      io_uring_setup: 425,
    },
    denyAtOrAbove: X32_SYSCALL_BIT,
  },
  arm64: {
    auditArch: 0xc00000b7,
    seccompSyscall: 277,
    denied: {
      execve: 221,
      ptrace: 117,
      process_vm_readv: 270,
      process_vm_writev: 271,
      execveat: 281,
      io_uring_setup: 425,
    },
  },
};

type Instruction = [code: number, jt: number, jf: number, k: number];

/**
 * Build the BPF program for one architecture. A syscall made under any other
 * audit arch (for example the i386 ABI on an x86_64 kernel) kills the process,
 * because its syscall numbers do not match the table.
 */
export function buildExecDenyProgram(table: ArchTable): Instruction[] {
  const deniedNumbers = Object.values(table.denied);
  const program: Instruction[] = [
    [BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH],
    [BPF_JMP_JEQ_K, 1, 0, table.auditArch],
    [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
    [BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR],
  ];
  // Every check below jumps to the trailing EPERM return on a match. Each
  // instruction's jump offset is the count of instructions between it and
  // that return, minus the ALLOW return that sits just before it.
  const checks = (table.denyAtOrAbove === undefined ? 0 : 1) + deniedNumbers.length;
  let remaining = checks;
  if (table.denyAtOrAbove !== undefined) {
    remaining -= 1;
    program.push([BPF_JMP_JGE_K, remaining + 1, 0, table.denyAtOrAbove]);
  }
  for (const nr of deniedNumbers) {
    remaining -= 1;
    program.push([BPF_JMP_JEQ_K, remaining + 1, 0, nr]);
  }
  program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW]);
  program.push([BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM]);
  return program;
}

export function encodeProgram(program: Instruction[]): Uint8Array {
  const bytes = new Uint8Array(program.length * 8);
  const view = new DataView(bytes.buffer);
  program.forEach(([code, jt, jf, k], i) => {
    view.setUint16(i * 8, code, true);
    view.setUint8(i * 8 + 2, jt);
    view.setUint8(i * 8 + 3, jf);
    view.setUint32(i * 8 + 4, k >>> 0, true);
  });
  return bytes;
}

export type SeccompInstallResult = { installed: true } | { installed: false; reason: string };

// The kernel copies the program during the syscall; these references only
// keep the buffers alive across the FFI call.
const retained: Uint8Array[] = [];

export async function installExecDenyFilter(): Promise<SeccompInstallResult> {
  if (process.platform !== "linux") return { installed: false, reason: "not linux" };
  const table = SECCOMP_ARCH_TABLES[process.arch];
  if (!table) return { installed: false, reason: `unsupported arch ${process.arch}` };

  let ffi: typeof import("bun:ffi");
  try {
    ffi = await import("bun:ffi");
  } catch (error) {
    return { installed: false, reason: `bun:ffi unavailable: ${String(error)}` };
  }

  let libc: ReturnType<typeof openLibc>;
  try {
    libc = openLibc(ffi);
  } catch (error) {
    return { installed: false, reason: `libc unavailable: ${String(error)}` };
  }

  try {
    const filter = encodeProgram(buildExecDenyProgram(table));
    const fprog = new Uint8Array(16);
    const fprogView = new DataView(fprog.buffer);
    fprogView.setUint16(0, filter.length / 8, true);
    fprogView.setBigUint64(8, BigInt(ffi.ptr(filter)), true);
    retained.push(filter, fprog);

    const nnp = libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n);
    if (nnp !== 0) return { installed: false, reason: `prctl(NO_NEW_PRIVS) returned ${nnp}` };
    const rc = Number(
      libc.symbols.syscall(
        BigInt(table.seccompSyscall),
        BigInt(SECCOMP_SET_MODE_FILTER),
        BigInt(SECCOMP_FILTER_FLAG_TSYNC),
        ffi.ptr(fprog),
      ),
    );
    // With TSYNC, a positive return is the id of a thread that could not be
    // synchronized; the filter is not installed.
    if (rc !== 0) return { installed: false, reason: `seccomp() returned ${rc}` };
    return { installed: true };
  } finally {
    libc.close();
  }
}

function openLibc(ffi: typeof import("bun:ffi")) {
  const symbols = {
    prctl: {
      args: ["i32", "u64", "u64", "u64", "u64"],
      returns: "i32",
    },
    syscall: {
      args: ["i64", "i64", "i64", "ptr"],
      returns: "i64",
    },
  } as const;
  let lastError: unknown;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      return ffi.dlopen(name, symbols);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Harness policy, passed by the executor in `SWARM_SCRIPT_SECCOMP`:
 * `required` fails the run when the filter cannot be installed,
 * `best-effort` (the default) continues without it, `off` skips it.
 */
export type SeccompPolicy = "required" | "best-effort" | "off";

export function parseSeccompPolicy(value: string | undefined): SeccompPolicy {
  return value === "required" || value === "off" ? value : "best-effort";
}
