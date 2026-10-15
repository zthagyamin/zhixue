using System;
using System.Diagnostics;
using System.ComponentModel;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Zhixue Companion Setup")]
[assembly: AssemblyDescription("Install or safely update Zhixue Companion")]
[assembly: AssemblyVersion("__ASSEMBLY_VERSION__")]
[assembly: AssemblyFileVersion("__ASSEMBLY_VERSION__")]

namespace ZhixueInstaller
{
    internal static class Program
    {
        private static string Quote(string value)
        {
            if (value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
                throw new ArgumentException("安装路径包含无效字符。");
            return "\"" + value + "\"";
        }

        private static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            bool nonInteractive = Array.IndexOf(args, "--non-interactive") >= 0;
            string temporaryRoot = Path.Combine(Path.GetTempPath(), "zhixue-companion-installer-" + Guid.NewGuid().ToString("N"));
            try
            {
                string target = null;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--target")
                    {
                        if (++i >= args.Length) throw new ArgumentException("--target 后需要安装目录。");
                        target = Path.GetFullPath(args[i]).TrimEnd('\\', '/');
                        if (target.Length <= 3) throw new ArgumentException("请选择一个具体安装文件夹。");
                    }
                    else if (args[i] != "--verify-only" && args[i] != "--no-start" && args[i] != "--skip-registration" && args[i] != "--non-interactive")
                        throw new ArgumentException("无法识别安装参数：" + args[i]);
                }
                Directory.CreateDirectory(temporaryRoot);
                string payloadZip = Path.Combine(temporaryRoot, "payload.zip");
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("ZhixuePayload"))
                using (FileStream output = File.Create(payloadZip))
                {
                    if (payload == null) throw new InvalidDataException("Installer payload missing");
                    payload.CopyTo(output);
                }
                ZipFile.ExtractToDirectory(payloadZip, temporaryRoot);
                string payloadRoot = Path.Combine(temporaryRoot, "zhixue-companion");
                string installerScript = Path.Combine(payloadRoot, "install-or-upgrade.ps1");
                if (Array.IndexOf(args, "--verify-only") >= 0)
                {
                    if (!File.Exists(installerScript) || !File.Exists(Path.Combine(payloadRoot, "version.json"))) return 2;
                    Console.WriteLine("Zhixue Companion installer payload verified.");
                    return 0;
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(installerScript) + " -PayloadRoot " + Quote(payloadRoot);
                if (target != null) startInfo.Arguments += " -TargetPath " + Quote(target);
                if (nonInteractive) startInfo.Arguments += " -NonInteractive";
                if (Array.IndexOf(args, "--no-start") >= 0) startInfo.Arguments += " -NoStart";
                if (Array.IndexOf(args, "--skip-registration") >= 0) startInfo.Arguments += " -SkipRegistration";
                startInfo.WorkingDirectory = payloadRoot;
                startInfo.UseShellExecute = false;
                // Do not pass PowerShell 7's module search path into Windows PowerShell.
                Environment.SetEnvironmentVariable("PSModulePath", null);
                int installExit = OwnedInstallation.Run(startInfo);
                if (installExit != 0 && !nonInteractive)
                {
                    Console.WriteLine("安装未完成。请保留上方错误信息；不要删除原安装目录或 data 文件夹。");
                    Console.WriteLine("按回车键关闭窗口。");
                    Console.ReadLine();
                }
                return installExit;
            }
            catch (Exception error)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("知学 Companion 安装失败：" + error.Message);
                Console.ResetColor();
                Console.WriteLine("按回车键关闭窗口。");
                if (!nonInteractive) Console.ReadLine();
                return 1;
            }
            finally
            {
                try
                {
                    if (Directory.Exists(temporaryRoot)) Directory.Delete(temporaryRoot, true);
                }
                catch { }
            }
        }
    }

    // The anonymous job contains only the PowerShell created by this invocation.
    // Nothing is located by PID, executable name, installation path or registry.
    internal static class OwnedInstallation
    {
        private const uint KillOnClose = 0x2000;

        internal static int Run(ProcessStartInfo info)
        {
            IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            Native.ProcessInformation process = new Native.ProcessInformation();
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
            bool attributesReady = false;
            try
            {
                SetClosePolicy(job, KillOnClose);
                Native.StartupInfoEx startup = new Native.StartupInfoEx();
                startup.Info.Size = Marshal.SizeOf(typeof(Native.StartupInfoEx));
                startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Info.Input = input = DuplicateStandardHandle(-10);
                startup.Info.Output = output = DuplicateStandardHandle(-11);
                startup.Info.Error = error = DuplicateStandardHandle(-12);
                UIntPtr length = UIntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref length);
                if (length == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(checked((int)length.ToUInt64()));
                if (!Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                attributesReady = true;
                jobs = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobs, job);
                handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handles, 0, input);
                Marshal.WriteIntPtr(handles, IntPtr.Size, output);
                Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
                // Association is atomic with process creation. There is no
                // create-then-assign window leaving a suspended orphan.
                if (!Native.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs,
                    new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero) ||
                    !Native.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                    new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                startup.Attributes = attributes;
                StringBuilder command = new StringBuilder("\"" + info.FileName + "\" " + info.Arguments);
                if (!Native.CreateProcess(info.FileName, command, IntPtr.Zero, IntPtr.Zero,
                    true, 0x80004, IntPtr.Zero, info.WorkingDirectory, ref startup, out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Native.ResumeThread(process.Thread) == uint.MaxValue)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Native.WaitForSingleObject(process.Process, uint.MaxValue) != 0)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                uint code;
                if (!Native.GetExitCodeProcess(process.Process, out code))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (code == 0)
                {
                    // An intentionally started Companion belongs to the user
                    // after successful installation, not to the exited setup.
                    SetClosePolicy(job, 0);
                }
                else
                {
                    try
                    {
                        if (!Native.TerminateJobObject(job, code))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        WaitForCleanup(job);
                    }
                    catch (Exception cleanupError)
                    {
                        // Cleanup failure is additional evidence, not a new
                        // installation result replacing the original failure.
                        Console.Error.WriteLine("安装返回 " + code + "；进程清理未确认：" + cleanupError.Message);
                    }
                }
                return unchecked((int)code);
            }
            finally
            {
                Native.CloseHandle(job);
                if (process.Process != IntPtr.Zero) Native.WaitForSingleObject(process.Process, 5000);
                if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) Native.CloseHandle(process.Process);
                if (input != IntPtr.Zero) Native.CloseHandle(input);
                if (output != IntPtr.Zero) Native.CloseHandle(output);
                if (error != IntPtr.Zero) Native.CloseHandle(error);
                if (attributesReady) Native.DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            }
        }

        private static void WaitForCleanup(IntPtr job)
        {
            Stopwatch clock = Stopwatch.StartNew();
            while (true)
            {
                Native.BasicAccounting status;
                if (!Native.QueryInformationJobObject(job, 1, out status,
                    Marshal.SizeOf(typeof(Native.BasicAccounting)), IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (status.ActiveProcesses == 0) return;
                if (clock.ElapsedMilliseconds >= 5000)
                    throw new TimeoutException("安装进程清理未完成，请保留原目录和备份。");
                System.Threading.Thread.Sleep(20);
            }
        }

        private static void SetClosePolicy(IntPtr job, uint flags)
        {
            Native.ExtendedLimits limits = new Native.ExtendedLimits();
            limits.Basic.Flags = flags;
            if (!Native.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Native.ExtendedLimits))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        private static IntPtr DuplicateStandardHandle(int kind)
        {
            IntPtr source = Native.GetStdHandle(kind);
            if (source == IntPtr.Zero || source == new IntPtr(-1))
                throw new Win32Exception("安装进程没有可用的标准输入输出。");
            IntPtr current = Native.GetCurrentProcess(), duplicate;
            if (!Native.DuplicateHandle(current, source, current, out duplicate, 0, true, 2))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return duplicate;
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct BasicLimits
        {
            internal long ProcessTime, JobTime;
            internal uint Flags;
            internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            internal uint ActiveProcesses;
            internal UIntPtr Affinity;
            internal uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters
        {
            internal ulong ReadOperations, WriteOperations, OtherOperations;
            internal ulong ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ExtendedLimits
        {
            internal BasicLimits Basic;
            internal IoCounters Io;
            internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfo
        {
            internal int Size;
            internal string Reserved, Desktop, Title;
            internal uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            internal ushort Show, ReservedSize;
            internal IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            internal IntPtr Process, Thread;
            internal uint ProcessId, ThreadId;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx
        {
            internal StartupInfo Info;
            internal IntPtr Attributes;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct BasicAccounting
        {
            internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits information, int length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcess(string application, StringBuilder command,
            IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags,
            IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryInformationJobObject(IntPtr job, int kind,
            out BasicAccounting information, int length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr length);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
            IntPtr value, UIntPtr length, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source,
            IntPtr destinationProcess, out IntPtr destination, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}
