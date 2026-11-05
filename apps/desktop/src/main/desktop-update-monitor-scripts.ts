/** Runs in Apple's system JavaScript runtime, outside the app being replaced. */
export const macUpdateMonitorScript = String.raw`
ObjC.import('Cocoa');
function run(argv) {
  var statePath = argv[0];
  function readState() {
    var text = $.NSString.stringWithContentsOfFileEncodingError($(statePath), $.NSUTF8StringEncoding, null);
    if (!text) throw new Error('Update monitor state is unreadable');
    return JSON.parse(ObjC.unwrap(text));
  }
  var initial = readState();
  var copy = initial.copy;
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  app.finishLaunching;
  var window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 440, 210), 3, 2, false);
  window.title = copy.title;
  window.releasedWhenClosed = false;
  function label(text, y, height, size) {
    var field = $.NSTextField.wrappingLabelWithString($(text));
    field.frame = $.NSMakeRect(28, y, 384, height);
    field.font = $.NSFont.systemFontOfSize(size);
    window.contentView.addSubview(field);
    return field;
  }
  var title = label(copy.preparing, 144, 32, 18);
  var detail = label(copy.detail, 78, 58, 13);
  var elapsed = label('', 32, 28, 12);
  var spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(388, 157, 18, 18));
  spinner.style = 1;
  spinner.startAnimation(null);
  window.contentView.addSubview(spinner);
  window.center;
  window.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  $(JSON.stringify({pid: Number($.NSProcessInfo.processInfo.processIdentifier)})).writeToFileAtomicallyEncodingError($(statePath + '.ready'), true, $.NSUTF8StringEncoding, null);
  var completedAt = 0;
  while (window.isVisible) {
    try {
      var state = readState();
      var seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
      elapsed.stringValue = $(copy.elapsed.replace('{time}', Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2)));
      var terminal = state.phase === 'completed' || state.phase === 'error';
      title.stringValue = $(state.phase === 'completed' ? copy.completed : state.phase === 'error' ? copy.failed : state.phase === 'installing' ? copy.installing : copy.preparing);
      detail.stringValue = $(state.error || (seconds >= 120 && !terminal ? copy.slow : copy.detail));
      if (terminal) spinner.stopAnimation(null);
      if (state.phase === 'completed') {
        if (!completedAt) completedAt = Date.now();
        if (Date.now() - completedAt > 1500) break;
      }
    } catch (error) {
      title.stringValue = $(copy.failed);
      detail.stringValue = $(String(error));
      spinner.stopAnimation(null);
    }
    var event = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSUIntegerMax, $.NSDate.dateWithTimeIntervalSinceNow(0.5), $.NSDefaultRunLoopMode, true);
    if (event) app.sendEvent(event);
    app.updateWindows;
  }
  window.orderOut(null);
  $.NSFileManager.defaultManager.removeItemAtPathError($(initial.directory), null);
}
`;

/** WPF runs in the system PowerShell executable, so NSIS can replace Mori.exe. */
export const windowsUpdateMonitorScript = String.raw`
param([Parameter(Mandatory=$true)][string]$StatePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
function Read-State { Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json }
$initial = Read-State
$copy = $initial.copy
$window = New-Object System.Windows.Window
$window.Title = $copy.title
$window.Width = 460
$window.Height = 240
$window.ResizeMode = 'NoResize'
$window.WindowStartupLocation = 'CenterScreen'
$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = '28,24,28,24'
$heading = New-Object System.Windows.Controls.TextBlock
$heading.FontSize = 18
$heading.Text = $copy.preparing
$panel.Children.Add($heading) | Out-Null
$detail = New-Object System.Windows.Controls.TextBlock
$detail.TextWrapping = 'Wrap'
$detail.Margin = '0,14,0,16'
$detail.Text = $copy.detail
$panel.Children.Add($detail) | Out-Null
$progress = New-Object System.Windows.Controls.ProgressBar
$progress.IsIndeterminate = $true
$progress.Height = 4
$panel.Children.Add($progress) | Out-Null
$elapsed = New-Object System.Windows.Controls.TextBlock
$elapsed.Margin = '0,14,0,0'
$panel.Children.Add($elapsed) | Out-Null
$window.Content = $panel
$script:completedAt = $null
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  try {
    $state = Read-State
    $seconds = [Math]::Max(0, [Math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $state.startedAt) / 1000))
    $time = '{0}:{1:00}' -f [Math]::Floor($seconds / 60), ($seconds % 60)
    $elapsed.Text = $copy.elapsed.Replace('{time}', $time)
    switch ($state.phase) {
      'completed' {
        $heading.Text = $copy.completed
        $progress.IsIndeterminate = $false
        $progress.Value = 100
        if (!$script:completedAt) { $script:completedAt = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - $script:completedAt).TotalSeconds -gt 1.5) { $window.Close() }
      }
      'error' { $heading.Text = $copy.failed; $progress.IsIndeterminate = $false }
      'installing' { $heading.Text = $copy.installing }
      default { $heading.Text = $copy.preparing }
    }
    if ($state.error) { $detail.Text = $state.error }
    elseif ($seconds -ge 120 -and $state.phase -notin @('completed', 'error')) { $detail.Text = $copy.slow }
    else { $detail.Text = $copy.detail }
  } catch {
    $heading.Text = $copy.failed
    $detail.Text = $_.Exception.Message
    $progress.IsIndeterminate = $false
  }
})
$window.Add_ContentRendered({
  [IO.File]::WriteAllText($StatePath + '.ready', (@{pid=$PID} | ConvertTo-Json -Compress))
  $timer.Start()
})
try { $window.ShowDialog() | Out-Null }
finally {
  $timer.Stop()
  Remove-Item -LiteralPath $initial.directory -Recurse -Force
}
`;
