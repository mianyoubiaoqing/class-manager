using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// 仅驱动本次启动的验收NSIS进程；不发送键盘/鼠标事件，不读取其他程序窗口。
class InstallerWizardProbe {
  static Dictionary<uint, long> owners;
  delegate bool Callback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr context, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint Size, Usage, ProcessId; public IntPtr Heap; public uint Module, Threads, ParentProcessId; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
  }
  static long Birth(uint id) {
    try { using (var process=Process.GetProcessById((int)id)) { return process.StartTime.ToUniversalTime().Ticks; } }
    catch (ArgumentException) { return 0; } catch (System.ComponentModel.Win32Exception) { return 0; } catch (InvalidOperationException) { return 0; }
  }
  static bool Current(uint id, long birth) { return birth != 0 && Birth(id)==birth; }
  static void RequireOwned(IntPtr window) {
    uint id; GetWindowThreadProcessId(window, out id); long birth;
    if (owners == null || !owners.TryGetValue(id, out birth) || !Current(id, birth)) throw new Exception("Owned process identity changed");
  }
  static void Action(IntPtr window, uint message) { RequireOwned(window); if (!PostMessage(window, message, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Owned wizard action could not be queued"); }
  static void Descendants(Dictionary<uint, long> tracked) {
    var snapshot=CreateToolhelp32Snapshot(2, 0);
    try {
      var entries=new List<ProcessEntry>(); var entry=new ProcessEntry { Size=(uint)Marshal.SizeOf(typeof(ProcessEntry)) };
      if (Process32First(snapshot, ref entry)) do { entries.Add(entry); } while (Process32Next(snapshot, ref entry));
      bool added; do { added=false; foreach (var item in entries) {
        long parentBirth; if (tracked.ContainsKey(item.ProcessId) || !tracked.TryGetValue(item.ParentProcessId, out parentBirth) || !Current(item.ParentProcessId, parentBirth)) continue;
        var childBirth=Birth(item.ProcessId); if (childBirth >= parentBirth && childBirth != 0) { tracked.Add(item.ProcessId, childBirth); added=true; }
      } } while (added);
      // PID必须与创建时间一起匹配；退出的身份不能用于辨认之后复用该PID的进程。
      var ended=new List<uint>(); foreach (var identity in tracked) if (!Current(identity.Key, identity.Value)) ended.Add(identity.Key);
      foreach (var id in ended) tracked.Remove(id);
    } finally { CloseHandle(snapshot); }
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr first, string text);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr first, StringBuilder text);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  class Control {
    public long Handle; public int Id; public string Kind, Text; public bool Enabled;
  }
  static string Text(IntPtr window) { RequireOwned(window); var text = new StringBuilder(8192); if (Kind(window)=="Edit") SendMessage(window, 0x000D, new IntPtr(text.Capacity), text); else GetWindowText(window, text, text.Capacity); return text.ToString(); }
  static string Kind(IntPtr window) { var text = new StringBuilder(100); GetClassName(window, text, text.Capacity); return text.ToString(); }
  static List<Control> Controls(IntPtr window) {
    RequireOwned(window);
    var controls = new List<Control>();
    EnumChildWindows(window, (child, parameter) => {
      if (IsWindowVisible(child)) controls.Add(new Control { Handle=child.ToInt64(), Id=GetDlgCtrlID(child), Kind=Kind(child), Text=Text(child), Enabled=IsWindowEnabled(child) });
      return true;
    }, IntPtr.Zero); return controls;
  }
  static IntPtr Window(Dictionary<uint, long> tracked) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((window, parameter) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      long birth;
      if (tracked.TryGetValue(owner, out birth) && Current(owner, birth) && IsWindowVisible(window) && Kind(window) == "#32770") {
        result=window; if (IsWindowEnabled(window)) return false;
      }
      return true;
    }, IntPtr.Zero); return result;
  }
  static void Snapshot(IntPtr window, string file) {
    RequireOwned(window);
    Rect rect; if (!GetWindowRect(window, out rect)) throw new Exception("Wizard rectangle unavailable");
    using (var bitmap = new Bitmap(rect.Right-rect.Left, rect.Bottom-rect.Top))
    using (var graphics = Graphics.FromImage(bitmap)) {
      var context = graphics.GetHdc(); bool captured;
      try { captured=PrintWindow(window, context, 0); } finally { graphics.ReleaseHdc(context); }
      if (!captured) throw new Exception("Wizard capture failed");
      bitmap.Save(file, ImageFormat.Png);
    }
  }
  static int Main(string[] arguments) {
    var pages = new List<object>(); Process process = null;
    try {
      if (arguments.Length < 3 || arguments.Length > 4) throw new Exception("Expected isolated installer, directory, report directory and optional --bootstrap");
      bool bootstrap=arguments.Length == 4 && arguments[3] == "--bootstrap";
      SetProcessDPIAware(); Directory.CreateDirectory(arguments[2]);
      Console.OutputEncoding=new UTF8Encoding(false);
      process=Process.Start(new ProcessStartInfo(arguments[0]) { UseShellExecute=false });
      owners=new Dictionary<uint, long> { { (uint)process.Id, process.StartTime.ToUniversalTime().Ticks } };
      var deadline=DateTime.UtcNow.AddSeconds(bootstrap ? 20 : 120); var previous=""; bool chosen=false, completed=false, chinese=false;
      while (DateTime.UtcNow < deadline) {
        Descendants(owners);
        var window=Window(owners); if (window == IntPtr.Zero) { if (process.HasExited && owners.Count == 0) break; Thread.Sleep(50); continue; }
        var controls=Controls(window); var next=controls.Find(control => control.Kind=="Button" && control.Id==1);
        var edit=controls.Find(control => control.Kind=="Edit" && control.Id==1019);
        var content=String.Join("|", controls.ConvertAll(control => control.Kind+":"+control.Id+":"+control.Text).ToArray());
        if (Text(window) == "NSIS Error" || content.Contains("Error writing temporary file")) {
          var errorImage=Path.Combine(arguments[2], "nsis-error.png"); Snapshot(window, errorImage);
          pages.Add(new { title=Text(window), controls=controls, screenshot=errorImage });
          Action(window, 0x0010);
          throw new Exception("NSIS bootstrap error: "+content);
        }
        if (bootstrap && next != null) {
          var bootstrapImage=Path.Combine(arguments[2], "bootstrap.png"); Snapshot(window, bootstrapImage);
          pages.Add(new { title=Text(window), controls=controls, screenshot=bootstrapImage });
          Action(window, 0x0010);
          Thread.Sleep(200);
          Descendants(owners); var confirmation=Window(owners);
          if (confirmation != IntPtr.Zero) {
            var cancel=Controls(confirmation).Find(control => control.Kind=="Button" && (control.Text.Contains("是") || control.Text=="Yes"));
            if (cancel != null) Action(new IntPtr(cancel.Handle), 0x00F5);
          }
          File.WriteAllText(Path.Combine(arguments[2], "wizard-report.json"), new JavaScriptSerializer().Serialize(new { status="bootstrap-passed", installer=arguments[0], processId=process.Id, pages=pages }), new UTF8Encoding(false));
          return 0;
        }
        if (next == null || !next.Enabled) { Thread.Sleep(150); continue; }
        var page=Text(window)+"|"+content;
        if (page == previous) { Thread.Sleep(100); continue; }
        previous=page;
        if (next.Text.Contains("下一步") || next.Text.Contains("安装") || next.Text.Contains("完成")) chinese=true;
        if (edit != null) {
          RequireOwned(new IntPtr(edit.Handle));
          SendMessage(new IntPtr(edit.Handle), 0x000C, IntPtr.Zero, arguments[1]);
          if (Text(new IntPtr(edit.Handle)) != arguments[1]) throw new Exception("Directory selection did not take effect");
          chosen=true; controls=Controls(window);
        }
        if (next.Text.Contains("安装") && !chosen) throw new Exception("Refusing installation before the isolated directory is verified");
        var screenshot=Path.Combine(arguments[2], "wizard-"+pages.Count.ToString("D2")+".png");
        Snapshot(window, screenshot);
        pages.Add(new { title=Text(window), controls=controls, screenshot=screenshot });
        Console.WriteLine("Wizard page: "+next.Text+"; directory selected="+chosen);
        if (next.Text.Contains("完成")) {
          if (!chosen) throw new Exception("No directory page observed");
          if (!File.Exists(Path.Combine(arguments[1], "Class Manager.exe"))) throw new Exception("Application was not installed");
          completed=true;
        }
        Action(new IntPtr(next.Handle), 0x00F5);
        Thread.Sleep(300);
      }
      if (!process.HasExited && !process.WaitForExit(10000)) throw new Exception("Wizard did not exit");
      if (process.ExitCode != 0 || !completed || !chinese) throw new Exception("Wizard completion or Chinese UI not verified");
      File.WriteAllText(Path.Combine(arguments[2], "wizard-report.json"), new JavaScriptSerializer().Serialize(new {
        status="passed", installer=arguments[0], installationDirectory=arguments[1], processId=process.Id,
        chineseInterface=chinese, directorySelected=chosen, completed=completed, exitCode=process.ExitCode, pages=pages
      }), new UTF8Encoding(false)); return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error);
      if (arguments.Length >= 3) File.WriteAllText(Path.Combine(arguments[2], "wizard-report.json"), new JavaScriptSerializer().Serialize(new { status="failed", error=error.ToString(), exitCode=process != null && process.HasExited ? (int?)process.ExitCode : null, pages=pages }), new UTF8Encoding(false));
      // 只关闭当前验收向导，不关闭任何现有程序；保留可能的部分安装供诊断。
      if (owners != null) {
        Descendants(owners); var ownWindow=Window(owners);
        if (ownWindow != IntPtr.Zero) Action(ownWindow, 0x0010);
      }
      return 1;
    }
  }
}
