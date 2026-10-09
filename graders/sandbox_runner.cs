// graders/sandbox_runner.cs โ€” Windows sandbox launcher for untrusted student code.
// Build:  csc /nologo /optimize /out:sandbox_runner.exe sandbox_runner.cs   (see graders/build_runner.ps1)
// Usage:  sandbox_runner.exe <timeoutMs> <memMB> <maxProcs> <cwd> <exe> [args...]
//
// The child runs with
//   * a restricted token: all privileges dropped (except bypass-traverse), and a restricting-SID list of
//     {Everyone, Users, logon SID} so it can only touch objects that grant access to those SIDs โ€”
//     the owner's profile (data/, Documents, browser cookies, ...) grants only the user's own SID, so it is unreadable;
//   * Low integrity level, so it cannot write to anything that is not labelled Low (the sandbox scratch dir is);
//   * a Job Object: per-process memory cap, active-process cap (no fork bombs / no spawning shells),
//     kill-on-close (dies with this launcher), and UI restrictions.
// stdin/stdout/stderr are inherited from this launcher. Exit code: child's exit code, 124 on timeout, 125 on launcher error.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class SandboxRunner
{
    const uint TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80;
    const uint DISABLE_MAX_PRIVILEGE = 0x1;
    const uint SE_GROUP_INTEGRITY = 0x20, SE_GROUP_LOGON_ID = 0xC0000000;
    const int TokenGroups = 2, TokenIntegrityLevel = 25;
    // DETACHED_PROCESS, not CREATE_NO_WINDOW: a Low-integrity child cannot attach to a freshly created console
    // (STATUS_DLL_INIT_FAILED), and the child only needs the redirected std handles anyway.
    const uint CREATE_SUSPENDED = 0x4, DETACHED_PROCESS = 0x8;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint WAIT_TIMEOUT = 0x102, MAXIMUM_ALLOWED = 0x02000000;

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint nDisable, IntPtr disable, uint nDelete, IntPtr del,
        uint nRestrict, SID_AND_ATTRIBUTES[] restrict, out IntPtr newTok);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(IntPtr tok, uint access, IntPtr attrs, int impersonationLevel, int tokenType, out IntPtr newTok);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    static void Check(bool ok, string what) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), what + " (win32 error " + Marshal.GetLastWin32Error() + ")"); }

    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1).Append('"'); bs = 0; continue; }
            sb.Append('\\', bs).Append(c); bs = 0;
        }
        sb.Append('\\', bs * 2).Append('"');
        return sb.ToString();
    }

    static IntPtr Sid(string s) { IntPtr p; Check(ConvertStringSidToSid(s, out p), "ConvertStringSidToSid " + s); return p; }

    static IntPtr LogonSid(IntPtr tok)
    {
        int len; GetTokenInformation(tok, TokenGroups, IntPtr.Zero, 0, out len);
        IntPtr buf = Marshal.AllocHGlobal(len);
        Check(GetTokenInformation(tok, TokenGroups, buf, len, out len), "GetTokenInformation(groups)");
        int count = Marshal.ReadInt32(buf);
        int off = IntPtr.Size;            // TOKEN_GROUPS: DWORD GroupCount, (pad), SID_AND_ATTRIBUTES[]
        for (int i = 0; i < count; i++)
        {
            IntPtr e = IntPtr.Add(buf, off + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
            var g = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(e, typeof(SID_AND_ATTRIBUTES));
            if ((g.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) return g.Sid;   // buf intentionally kept alive
        }
        throw new Exception("logon SID not found");
    }

    static IntPtr MakeSandboxToken()
    {
        IntPtr self;
        Check(OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, out self), "OpenProcessToken");
        var restrict = new[] {
            new SID_AND_ATTRIBUTES { Sid = Sid("S-1-1-0") },        // Everyone
            new SID_AND_ATTRIBUTES { Sid = Sid("S-1-5-32-545") },   // BUILTIN\Users
            new SID_AND_ATTRIBUTES { Sid = LogonSid(self) },        // needed for desktop / window-station access
        };
        // Lower the integrity level on a full-access duplicate first; CreateRestrictedToken keeps it.
        IntPtr dup;
        Check(DuplicateTokenEx(self, MAXIMUM_ALLOWED, IntPtr.Zero, 2 /*SecurityImpersonation*/, 1 /*TokenPrimary*/, out dup), "DuplicateTokenEx");
        IntPtr low = Sid("S-1-16-4096");
        int size = Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + (int)GetLengthSid(low);
        IntPtr tml = Marshal.AllocHGlobal(size);
        Marshal.WriteIntPtr(tml, low);
        Marshal.WriteInt32(tml, IntPtr.Size, (int)SE_GROUP_INTEGRITY);
        Check(SetTokenInformation(dup, TokenIntegrityLevel, tml, size), "SetTokenInformation(integrity)");

        // Objects the child creates (pipes, events, temp files) get this DACL. The default one names only the user's own SID,
        // which the restricting-SID pass would reject — g++ then fails with "pipe: Permission denied". Grant the restricting SIDs too.
        var acl = new RawAcl(2, 5);
        var owners = new[] {
            WindowsIdentity.GetCurrent().User,
            new SecurityIdentifier("S-1-5-18"),
            new SecurityIdentifier("S-1-1-0"),
            new SecurityIdentifier("S-1-5-32-545"),
            new SecurityIdentifier(restrict[2].Sid),
        };
        for (int i = 0; i < owners.Length; i++)
            acl.InsertAce(i, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000 /*GENERIC_ALL*/, owners[i], false, null));
        byte[] aclBytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(aclBytes, 0);
        IntPtr aclPtr = Marshal.AllocHGlobal(aclBytes.Length);
        Marshal.Copy(aclBytes, 0, aclPtr, aclBytes.Length);
        IntPtr tdd = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(tdd, aclPtr);
        Check(SetTokenInformation(dup, 6 /*TokenDefaultDacl*/, tdd, IntPtr.Size), "SetTokenInformation(default dacl)");

        IntPtr tok;
        Check(CreateRestrictedToken(dup, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Length, restrict, out tok),
              "CreateRestrictedToken");
        return tok;
    }

    static IntPtr MakeJob(ulong memBytes, uint maxProcs)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.Basic.LimitFlags = 0x100 /*PROCESS_MEMORY*/ | 0x8 /*ACTIVE_PROCESS*/ | 0x2000 /*KILL_ON_JOB_CLOSE*/ | 0x400 /*DIE_ON_UNHANDLED_EXCEPTION*/;
        ext.Basic.ActiveProcessLimit = maxProcs;
        ext.ProcessMemoryLimit = new UIntPtr(memBytes);
        int sz = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(sz);
        Marshal.StructureToPtr(ext, p, false);
        Check(SetInformationJobObject(job, 9, p, sz), "SetInformationJobObject(limits)");
        IntPtr ui = Marshal.AllocHGlobal(4);
        Marshal.WriteInt32(ui, 0xFF);   // all UI restrictions
        Check(SetInformationJobObject(job, 4, ui, 4), "SetInformationJobObject(ui)");
        return job;
    }

    static int Main(string[] argv)
    {
        if (argv.Length < 5) { Console.Error.WriteLine("usage: sandbox_runner <timeoutMs> <memMB> <maxProcs> <cwd> <exe> [args...]"); return 125; }
        try
        {
            uint timeout = uint.Parse(argv[0]);
            ulong mem = ulong.Parse(argv[1]) * 1024UL * 1024UL;
            uint procs = uint.Parse(argv[2]);
            string cwd = argv[3], exe = argv[4];

            var cmd = new StringBuilder(Quote(exe));
            for (int i = 5; i < argv.Length; i++) cmd.Append(' ').Append(Quote(argv[i]));

            IntPtr tok = MakeSandboxToken();
            IntPtr job = MakeJob(mem, procs);

            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = (int)STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
            foreach (var h in new[] { si.hStdInput, si.hStdOutput, si.hStdError })
                if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

            PROCESS_INFORMATION pi;
            Check(CreateProcessAsUser(tok, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | DETACHED_PROCESS,
                                      IntPtr.Zero, cwd, ref si, out pi), "CreateProcessAsUser(" + exe + ")");
            if (!AssignProcessToJobObject(job, pi.hProcess))
            {
                int e = Marshal.GetLastWin32Error();
                // child is still suspended and unconfined: never let it run
                TerminateJobObject(job, 125); // no-op, but ensures nothing is left; kill the process directly below
                System.Diagnostics.Process.GetProcessById(pi.dwProcessId).Kill();
                throw new Win32Exception(e, "AssignProcessToJobObject");
            }
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            if (WaitForSingleObject(pi.hProcess, timeout) == WAIT_TIMEOUT)
            {
                TerminateJobObject(job, 124);
                return 124;
            }
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            TerminateJobObject(job, 0);   // reap anything the child left behind
            return unchecked((int)code);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("sandbox_runner: " + ex.Message);
            return 125;
        }
    }
}


