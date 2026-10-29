// Runs in Windows PowerShell 5.1, off Electron's main thread. System.Management
// is part of Windows; external monitors use the same DDC/CI APIs as Twinkle Tray.
// https://learn.microsoft.com/en-us/windows/win32/wmicoreprov/wmimonitorbrightness
// https://learn.microsoft.com/en-us/windows/win32/monitor/using-the-high-level-monitor-configuration-functions
export const WINDOWS_DISPLAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Management.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public class MoriMonitor {
  public string key, name, error;
  public bool internalDisplay;
  public double value;
}
public static class MoriDisplays {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct DisplayDevice {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct MonitorInfo {
    public int cbSize;
    public Rect monitor, work;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string device;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct PhysicalMonitor {
    public IntPtr handle;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string description;
  }
  delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevicesW(string device, uint index, ref DisplayDevice info, uint flags);
  [DllImport("dxva2.dll", SetLastError=true)] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
  [DllImport("dxva2.dll", SetLastError=true)] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PhysicalMonitor[] monitors);
  [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PhysicalMonitor[] monitors);
  [DllImport("dxva2.dll", SetLastError=true)] static extern bool GetMonitorBrightness(IntPtr monitor, out uint min, out uint value, out uint max);
  [DllImport("dxva2.dll", SetLastError=true)] static extern bool SetMonitorBrightness(IntPtr monitor, uint value);

  static Exception NativeError(string operation) {
    return new InvalidOperationException(operation + " failed (" + Marshal.GetLastWin32Error() + "). Check DDC/CI support and the monitor's settings.");
  }
  static string Identity(string id) {
    // EDD_GET_DEVICE_INTERFACE_NAME gives \\?\DISPLAY#vendor#instance#{guid};
    // WMI gives DISPLAY\vendor\instance_0. Match the actual PnP instance.
    if (id.StartsWith(@"\\?\")) {
      var parts=id.Substring(4).Split('#');
      if (parts.Length >= 3) id=parts[0]+"\\"+parts[1]+"\\"+parts[2];
    }
    return Regex.Replace(id.Replace("MONITOR\\", "DISPLAY\\"), @"_\d+$", "");
  }
  static List<MoriMonitor> Run(string target, double? requested) {
    var result = new List<MoriMonitor>();
    var internalIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    string wmiError = null;
    try {
      using (var search = new ManagementObjectSearcher(@"root\wmi", "SELECT * FROM WmiMonitorBrightness WHERE Active = TRUE"))
      using (var collection = search.Get()) {
        foreach (ManagementObject monitor in collection) using (monitor) {
          string instance = (string)monitor["InstanceName"];
          internalIds.Add(Identity(instance));
          string key = "wmi:" + instance;
          if (target != null && target != key) continue;
          var entry = new MoriMonitor { key=key, name=instance, internalDisplay=true };
          try {
            byte[] levels = (byte[])monitor["Level"];
            if (levels == null || levels.Length < 2) throw new InvalidOperationException("WMI brightness levels unavailable.");
            byte min=255, max=0;
            foreach (byte level in levels) { min=Math.Min(min, level); max=Math.Max(max, level); }
            if (min >= max) throw new InvalidOperationException("WMI brightness range unavailable.");
            entry.value = ((byte)monitor["CurrentBrightness"] - min) / (double)(max-min);
            if (requested.HasValue) {
              double wanted = min + requested.Value * (max-min);
              byte nearest=levels[0];
              foreach (byte level in levels) if (Math.Abs(level-wanted) < Math.Abs(nearest-wanted)) nearest=level;
              bool found=false;
              using (var methodsSearch = new ManagementObjectSearcher(@"root\wmi", "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active = TRUE"))
              using (var methods = methodsSearch.Get()) {
                foreach (ManagementObject method in methods) using (method) {
                  if (!String.Equals((string)method["InstanceName"], instance, StringComparison.OrdinalIgnoreCase)) continue;
                  object status = method.InvokeMethod("WmiSetBrightness", new object[] { (uint)0, nearest });
                  if (Convert.ToUInt32(status) != 0) throw new InvalidOperationException("WmiSetBrightness failed (" + status + ").");
                  found=true;
                }
              }
              if (!found) throw new InvalidOperationException("WMI brightness control unavailable.");
            }
          } catch (Exception error) { entry.error=error.Message; }
          result.Add(entry);
        }
      }
    } catch (Exception error) { wmiError=error.Message; }

    Exception enumerationError = null;
    MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data) {
      try {
      var info = new MonitorInfo { cbSize=Marshal.SizeOf(typeof(MonitorInfo)) };
      if (!GetMonitorInfoW(monitor, ref info)) throw NativeError("GetMonitorInfo");
      var device = new DisplayDevice { cb=Marshal.SizeOf(typeof(DisplayDevice)) };
      if (!EnumDisplayDevicesW(info.device, 0, ref device, 1) || String.IsNullOrEmpty(device.DeviceID)) {
        result.Add(new MoriMonitor { key="unsupported:"+info.device, name=info.device, error="A stable monitor identity is unavailable." });
        return true;
      }
      if (internalIds.Contains(Identity(device.DeviceID))) return true;
      uint count;
      if (!GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, out count) || count == 0) {
        result.Add(new MoriMonitor { key="ddc:"+device.DeviceID, name=device.DeviceString, error="Physical monitor control unavailable."+(wmiError == null ? "" : " WMI: "+wmiError) });
        return true;
      }
      if (count > 1) {
        result.Add(new MoriMonitor { key="unsupported:"+device.DeviceID, name=device.DeviceString, error="Multiple physical monitors share this logical display; independent stable identities are unavailable." });
        return true;
      }
      var physical = new PhysicalMonitor[count];
      if (!GetPhysicalMonitorsFromHMONITOR(monitor, count, physical)) throw NativeError("GetPhysicalMonitors");
      try {
        for (int i=0; i<physical.Length; i++) {
          string key="ddc:"+device.DeviceID+":"+i;
          if (target != null && target != key) continue;
          var entry = new MoriMonitor { key=key, name=physical[i].description };
          try {
            uint min, current, max;
            if (!GetMonitorBrightness(physical[i].handle, out min, out current, out max)) throw NativeError("GetMonitorBrightness");
            if (max <= min) throw new InvalidOperationException("Monitor brightness range unavailable.");
            entry.value=(current-min)/(double)(max-min);
            if (requested.HasValue && !SetMonitorBrightness(physical[i].handle, (uint)Math.Round(min+requested.Value*(max-min)))) throw NativeError("SetMonitorBrightness");
          } catch (Exception error) { entry.error=error.Message; }
          result.Add(entry);
        }
      } finally { DestroyPhysicalMonitors(count, physical); }
      return true;
      } catch (Exception error) { enumerationError=error; return false; }
    };
    bool enumerated=EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    if (enumerationError != null) throw enumerationError;
    if (!enumerated) throw NativeError("EnumDisplayMonitors");
    return result;
  }
  public static MoriMonitor[] List() { return Run(null, null).ToArray(); }
  public static MoriMonitor Read(string key) {
    foreach (var entry in Run(key, null)) if (entry.key == key) {
      if (entry.error != null) throw new InvalidOperationException(entry.error);
      return entry;
    }
    throw new InvalidOperationException("Monitor disconnected: "+key);
  }
  public static void Write(string key, double value) {
    if (Double.IsNaN(value) || value < 0 || value > 1) throw new ArgumentOutOfRangeException("value");
    foreach (var entry in Run(key, value)) if (entry.key == key) {
      if (entry.error != null) throw new InvalidOperationException(entry.error);
      return;
    }
    throw new InvalidOperationException("Monitor disconnected: "+key);
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    switch ($request.operation) {
      'list' { $result = @([MoriDisplays]::List()) }
      'get' { $result = [MoriDisplays]::Read([string]$request.key) }
      'set' { [MoriDisplays]::Write([string]$request.key, [double]$request.value); $result = $null }
      default { throw 'Unknown display operation.' }
    }
    $response = @{ result=$result }
  } catch { $response = @{ error=$_.Exception.Message } }
  [Console]::WriteLine((ConvertTo-Json -InputObject $response -Depth 5 -Compress))
}
`;
