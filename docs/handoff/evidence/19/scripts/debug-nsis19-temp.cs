// 诊断NSIS启动时的Win32操作；只创建和清理本探针自己的临时文件。
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
class TempProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetTempPath(uint length, StringBuilder path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetTempFileName(string path, string prefix, uint unique, StringBuilder file);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr data, uint size, out uint needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  static int Main(string[] args) {
    using (var identity=System.Security.Principal.WindowsIdentity.GetCurrent()) {
      Console.WriteLine("Identity="+identity.Name+"; Restricted="+IsTokenRestricted(identity.Token));
      uint needed; GetTokenInformation(identity.Token, 25, IntPtr.Zero, 0, out needed);
      var buffer=Marshal.AllocHGlobal((int)needed);
      try { if (GetTokenInformation(identity.Token, 25, buffer, needed, out needed)) {
        var sid=Marshal.ReadIntPtr(buffer); var count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        Console.WriteLine("TokenIntegrityRid="+Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count-1))));
      } } finally { Marshal.FreeHGlobal(buffer); }
      foreach (var group in identity.Groups) if (group.Value.StartsWith("S-1-16") || group.Value.StartsWith("S-1-15") || group.Value.StartsWith("S-1-4")) Console.WriteLine("Group="+group.Value);
    }
    var path=new StringBuilder(1024); var length=GetTempPath(1024, path);
    Console.WriteLine("PointerBytes="+IntPtr.Size+"; GetTempPath="+length+"; path="+path+"; error="+Marshal.GetLastWin32Error());
    foreach (var suffix in new string[] { ".txt", ".tmp" }) {
      foreach (var prefix in new string[] { "" }) {
      var direct=prefix+Path.Combine(path.ToString(), "nsis19-direct-"+Guid.NewGuid().ToString("N")+suffix);
      foreach (uint access in new uint[] { 0x40000000, 0xc0000000, 0x0012019f, 2 }) {
        var file=CreateFile(direct, access, 0, IntPtr.Zero, 1, 0x80, IntPtr.Zero);
        Console.WriteLine("CreateFile "+prefix+suffix+" access="+access+" handle="+file+" error="+Marshal.GetLastWin32Error());
        if (file != new IntPtr(-1)) { CloseHandle(file); File.Delete(direct); }
      }
      try { File.WriteAllText(direct, "write probe"); Console.WriteLine(".NET write passed "+suffix); File.Delete(direct); } catch(Exception e) { Console.WriteLine(".NET write failed "+e.Message); }
      }
    }
    var name=new StringBuilder(260); var created=GetTempFileName(path.ToString(), "nsx", 0, name);
    Console.WriteLine("GetTempFileName="+created+"; file="+name+"; error="+Marshal.GetLastWin32Error());
    if (created == 0) return 1;
    var handle=CreateFile(name.ToString(), 0xc0000000, 0, IntPtr.Zero, 2, 0x04000100, IntPtr.Zero);
    Console.WriteLine("CreateFile delete-on-close="+handle+"; error="+Marshal.GetLastWin32Error());
    if (handle != new IntPtr(-1)) CloseHandle(handle);
    else { File.Delete(name.ToString()); return 2; }
    return 0;
  }
}
