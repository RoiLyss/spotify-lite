using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class SpotifyLiteLauncher
{
    private const int Port = 43821;
    private static readonly string BaseDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    private static volatile bool running = true;

    [STAThread]
    private static void Main()
    {
        bool ownsServer = StartServer();

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (SpotifyLiteWindow window = new SpotifyLiteWindow())
        {
            Application.Run(window);
        }

        running = false;
        if (!ownsServer) return;
        try
        {
            using (TcpClient wake = new TcpClient()) wake.Connect(IPAddress.Loopback, Port);
        }
        catch { }
    }

    private static bool StartServer()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, Port);
        try { listener.Start(); }
        catch (SocketException) { return false; }

        Thread server = new Thread(delegate()
        {
            while (running)
            {
                try { Handle(listener.AcceptTcpClient()); }
                catch { if (!running) break; }
            }
            try { listener.Stop(); } catch { }
        });
        server.IsBackground = true;
        server.Name = "Spotify Lite local server";
        server.Start();
        return true;
    }

    private static void Handle(TcpClient client)
    {
        using (client)
        using (NetworkStream stream = client.GetStream())
        {
            string requestLine = ReadRequestLine(stream);
            if (String.IsNullOrEmpty(requestLine)) return;
            string[] parts = requestLine.Split(' ');
            string path = parts.Length > 1 ? parts[1].Split('?')[0] : "/";

            path = Uri.UnescapeDataString(path);
            if (path == "/" || path == "/callback") path = "/index.html";
            string relative = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            string file = Path.GetFullPath(Path.Combine(BaseDirectory, relative));
            string root = Path.GetFullPath(BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar);
            if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
            {
                WriteResponse(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Introuvable"));
                return;
            }

            string extension = Path.GetExtension(file).ToLowerInvariant();
            string type = extension == ".html" ? "text/html; charset=utf-8" :
                          extension == ".js" ? "text/javascript; charset=utf-8" :
                          extension == ".css" ? "text/css; charset=utf-8" :
                          extension == ".webmanifest" ? "application/manifest+json; charset=utf-8" :
                          extension == ".png" ? "image/png" :
                          extension == ".svg" ? "image/svg+xml" : "application/octet-stream";
            WriteResponse(stream, 200, type, File.ReadAllBytes(file));
        }
    }

    private static string ReadRequestLine(Stream stream)
    {
        List<byte> data = new List<byte>();
        byte[] buffer = new byte[8192];
        int headerEnd = -1;
        while (headerEnd < 0)
        {
            int read = stream.Read(buffer, 0, buffer.Length);
            if (read <= 0) return null;
            for (int index = 0; index < read; index++) data.Add(buffer[index]);
            for (int index = Math.Max(0, data.Count - read - 3); index <= data.Count - 4; index++)
                if (data[index] == 13 && data[index + 1] == 10 && data[index + 2] == 13 && data[index + 3] == 10) { headerEnd = index + 4; break; }
        }
        string headers = Encoding.UTF8.GetString(data.GetRange(0, headerEnd).ToArray());
        string[] lines = headers.Split(new[] { "\r\n" }, StringSplitOptions.None);
        return lines.Length > 0 ? lines[0] : null;
    }

    private static void WriteResponse(Stream stream, int status, string type, byte[] body)
    {
        string label = status >= 200 && status < 300 ? "OK" : status == 404 ? "Not Found" : "Error";
        byte[] headers = Encoding.ASCII.GetBytes(
            "HTTP/1.1 " + status + " " + label + "\r\n" +
            "Content-Type: " + type + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        stream.Write(headers, 0, headers.Length);
        if (body.Length > 0) stream.Write(body, 0, body.Length);
    }

    private sealed class SpotifyLiteWindow : Form
    {
        private readonly WebView2 browser = new WebView2();
        private readonly Panel titleBar = new Panel();
        private readonly Button maximizeButton = new TitleButton();
        private readonly ContextMenuStrip appMenu = new ContextMenuStrip();

        private sealed class TitleButton : Button
        {
            protected override bool ShowFocusCues { get { return false; } }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                const int SystemMenu = 0x00080000;
                const int MinimizeBox = 0x00020000;
                const int MaximizeBox = 0x00010000;
                CreateParams parameters = base.CreateParams;
                parameters.Style |= SystemMenu | MinimizeBox | MaximizeBox;
                return parameters;
            }
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

        public SpotifyLiteWindow()
        {
            Text = "Spotify Lite";
            BackColor = Color.FromArgb(8, 12, 10);
            FormBorderStyle = FormBorderStyle.None;
            MinimumSize = new Size(900, 620);
            Size = new Size(1440, 900);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            browser.Dock = DockStyle.Fill;
            browser.BackColor = BackColor;
            Controls.Add(browser);
            BuildTitleBar();
            Controls.Add(titleBar);
            Load += OnLoaded;
            Shown += delegate { UpdateMaximizedBounds(); };
            LocationChanged += delegate { if (WindowState == FormWindowState.Normal) UpdateMaximizedBounds(); };
        }

        private void BuildTitleBar()
        {
            titleBar.Dock = DockStyle.Top;
            titleBar.Height = 48;
            titleBar.BackColor = Color.FromArgb(7, 9, 8);
            titleBar.MouseDown += DragWindow;
            titleBar.MouseMove += delegate(object sender, MouseEventArgs e)
            {
                Cursor = WindowState == FormWindowState.Normal && e.Y <= 10 ? Cursors.SizeNS : Cursors.Default;
            };
            titleBar.MouseLeave += delegate { Cursor = Cursors.Default; };
            titleBar.DoubleClick += delegate { ToggleMaximize(); };

            Button menu = CreateTitleButton("\u2022\u2022\u2022", 52, false);
            menu.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            menu.Location = new Point(7, 0);
            BuildAppMenu();
            menu.Click += delegate { appMenu.Show(menu, new Point(0, menu.Height)); };
            titleBar.Controls.Add(menu);

            Button back = CreateTitleButton("\u2039", 46, false);
            back.Font = new Font("Segoe UI", 19F, FontStyle.Regular);
            back.Location = new Point(60, 1);
            back.Click += delegate { if (browser.CoreWebView2 != null && browser.CanGoBack) browser.GoBack(); };
            titleBar.Controls.Add(back);

            Button forward = CreateTitleButton("\u203a", 46, false);
            forward.Font = new Font("Segoe UI", 19F, FontStyle.Regular);
            forward.Location = new Point(106, 1);
            forward.Click += delegate { if (browser.CoreWebView2 != null && browser.CanGoForward) browser.GoForward(); };
            titleBar.Controls.Add(forward);

            Button minimize = CreateTitleButton("\u2014", 48, false);
            minimize.Dock = DockStyle.Right;
            minimize.Click += delegate { WindowState = FormWindowState.Minimized; };
            titleBar.Controls.Add(minimize);

            maximizeButton.Text = "\u25a1";
            StyleWindowButton(maximizeButton, 48, false);
            maximizeButton.Dock = DockStyle.Right;
            maximizeButton.Click += delegate { ToggleMaximize(); };
            titleBar.Controls.Add(maximizeButton);

            Button close = CreateTitleButton("\u00d7", 48, true);
            close.Dock = DockStyle.Right;
            close.Click += delegate { Close(); };
            titleBar.Controls.Add(close);

        }

        private void BuildAppMenu()
        {
            appMenu.BackColor = Color.FromArgb(35, 36, 36);
            appMenu.ForeColor = Color.White;
            appMenu.Font = new Font("Segoe UI", 9.5F);
            appMenu.Padding = new Padding(5);
            appMenu.ShowImageMargin = false;
            appMenu.Renderer = new ToolStripProfessionalRenderer(new DarkMenuColors());

            ToolStripMenuItem file = MenuGroup("Fichier");
            file.DropDownItems.Add(MenuAction("Creer une playlist", "Ctrl+N", "document.querySelector('#create-playlist-button')?.click()"));
            file.DropDownItems.Add(MenuAction("Mes playlists", "", "document.querySelector('[data-view=playlists]')?.click()"));
            file.DropDownItems.Add(new ToolStripSeparator());
            file.DropDownItems.Add(MenuAction("Deconnecter", "Ctrl+Shift+W", "document.querySelector('#menu-logout-button')?.click()"));
            ToolStripMenuItem quit = MenuItem("Quitter", "Ctrl+Shift+Q");
            quit.Click += delegate { Close(); };
            file.DropDownItems.Add(quit);

            ToolStripMenuItem edit = MenuGroup("Modifier");
            edit.DropDownItems.Add(MenuAction("Annuler", "Ctrl+Z", "document.execCommand('undo')"));
            edit.DropDownItems.Add(MenuAction("Retablir", "Ctrl+Y", "document.execCommand('redo')"));
            edit.DropDownItems.Add(new ToolStripSeparator());
            edit.DropDownItems.Add(MenuAction("Couper", "Ctrl+X", "document.execCommand('cut')"));
            edit.DropDownItems.Add(MenuAction("Copier", "Ctrl+C", "document.execCommand('copy')"));
            edit.DropDownItems.Add(MenuAction("Coller", "Ctrl+V", "document.execCommand('paste')"));
            edit.DropDownItems.Add(MenuAction("Tout selectionner", "Ctrl+A", "document.querySelector('#search-input')?.select()"));
            edit.DropDownItems.Add(new ToolStripSeparator());
            edit.DropDownItems.Add(MenuAction("Recherche", "Ctrl+L", "document.querySelector('#search-input')?.focus()"));

            ToolStripMenuItem view = MenuGroup("Afficher");
            view.DropDownItems.Add(MenuAction("Accueil", "Ctrl+H", "document.querySelector('[data-view=home]')?.click()"));
            view.DropDownItems.Add(MenuAction("Profil", "", "document.querySelector('#profile-menu-link')?.click()"));
            view.DropDownItems.Add(MenuAction("File d'attente", "", "document.querySelector('#queue-button')?.click()"));
            view.DropDownItems.Add(new ToolStripSeparator());
            view.DropDownItems.Add(MenuAction("Mini-lecteur", "Ctrl+M", "document.querySelector('#mini-button')?.click()"));
            ToolStripMenuItem reload = MenuItem("Actualiser", "Ctrl+R");
            reload.Click += delegate { if (browser.CoreWebView2 != null) browser.CoreWebView2.Reload(); };
            view.DropDownItems.Add(reload);

            ToolStripMenuItem playback = MenuGroup("Lecture");
            playback.DropDownItems.Add(MenuAction("Lecture / Pause", "Espace", "document.querySelector('#play-button')?.click()"));
            playback.DropDownItems.Add(MenuAction("Suivant", "Ctrl+Right", "document.querySelector('#next-button')?.click()"));
            playback.DropDownItems.Add(MenuAction("Precedent", "Ctrl+Left", "document.querySelector('#previous-button')?.click()"));
            playback.DropDownItems.Add(new ToolStripSeparator());
            playback.DropDownItems.Add(MenuAction("Lecture aleatoire", "Ctrl+S", "document.querySelector('#shuffle-button')?.click()"));
            playback.DropDownItems.Add(MenuAction("Repeter", "Ctrl+R", "document.querySelector('#repeat-button')?.click()"));
            playback.DropDownItems.Add(new ToolStripSeparator());
            playback.DropDownItems.Add(MenuAction("Augmenter le volume", "Ctrl+Up", "(()=>{const v=document.querySelector('#volume');v.value=Math.min(100,+v.value+5);v.dispatchEvent(new Event('input',{bubbles:true}))})()"));
            playback.DropDownItems.Add(MenuAction("Baisser le volume", "Ctrl+Down", "(()=>{const v=document.querySelector('#volume');v.value=Math.max(0,+v.value-5);v.dispatchEvent(new Event('input',{bubbles:true}))})()"));

            ToolStripMenuItem help = MenuGroup("Aide");
            help.DropDownItems.Add(LinkItem("Aide Spotify", "F1", "https://support.spotify.com/"));
            help.DropDownItems.Add(LinkItem("Communaute Spotify", "", "https://community.spotify.com/"));
            help.DropDownItems.Add(LinkItem("Votre compte", "", "https://www.spotify.com/account/overview/"));
            help.DropDownItems.Add(new ToolStripSeparator());
            ToolStripMenuItem about = MenuItem("A propos de Spotify Lite", "");
            about.Click += delegate { MessageBox.Show("Spotify Lite\nLecteur personnel leger pour Windows", "A propos", MessageBoxButtons.OK, MessageBoxIcon.Information); };
            help.DropDownItems.Add(about);

            appMenu.Items.AddRange(new ToolStripItem[] { file, edit, view, playback, help });
        }

        private ToolStripMenuItem MenuGroup(string text)
        {
            ToolStripMenuItem item = MenuItem(text, "");
            item.AutoSize = true;
            item.Width = 96;
            item.DropDown.BackColor = appMenu.BackColor;
            item.DropDown.ForeColor = Color.White;
            item.DropDown.Renderer = appMenu.Renderer;
            item.DropDown.Padding = new Padding(4);
            return item;
        }

        private ToolStripMenuItem MenuItem(string text, string shortcut)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.ShortcutKeyDisplayString = shortcut;
            item.AutoSize = false;
            item.Width = 250;
            item.Height = 30;
            return item;
        }

        private ToolStripMenuItem MenuAction(string text, string shortcut, string script)
        {
            ToolStripMenuItem item = MenuItem(text, shortcut);
            item.Click += delegate { RunScript(script); };
            return item;
        }

        private ToolStripMenuItem LinkItem(string text, string shortcut, string url)
        {
            ToolStripMenuItem item = MenuItem(text, shortcut);
            item.Click += delegate { try { Process.Start(url); } catch { } };
            return item;
        }

        private void RunScript(string script)
        {
            if (browser.CoreWebView2 != null) browser.CoreWebView2.ExecuteScriptAsync(script);
            browser.Focus();
        }

        private sealed class DarkMenuColors : ProfessionalColorTable
        {
            public override Color MenuItemSelected { get { return Color.FromArgb(62, 48, 57); } }
            public override Color MenuItemBorder { get { return Color.FromArgb(234, 79, 162); } }
            public override Color MenuItemSelectedGradientBegin { get { return MenuItemSelected; } }
            public override Color MenuItemSelectedGradientEnd { get { return MenuItemSelected; } }
            public override Color MenuItemPressedGradientBegin { get { return Color.FromArgb(48, 42, 46); } }
            public override Color MenuItemPressedGradientEnd { get { return Color.FromArgb(48, 42, 46); } }
            public override Color ToolStripDropDownBackground { get { return Color.FromArgb(35, 36, 36); } }
            public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
            public override Color SeparatorDark { get { return Color.FromArgb(70, 72, 71); } }
            public override Color SeparatorLight { get { return Color.FromArgb(70, 72, 71); } }
        }

        private Button CreateTitleButton(string text, int width, bool danger)
        {
            Button button = new TitleButton();
            button.Text = text;
            StyleWindowButton(button, width, danger);
            return button;
        }

        private void StyleWindowButton(Button button, int width, bool danger)
        {
            button.Width = width;
            button.Height = 48;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = Color.Transparent;
            button.ForeColor = Color.FromArgb(185, 194, 189);
            button.Font = new Font("Segoe UI", 12F, FontStyle.Regular);
            button.TabStop = false;
            button.FlatAppearance.MouseDownBackColor = danger ? Color.FromArgb(180, 35, 58) : Color.FromArgb(24, 29, 27);
            button.MouseEnter += delegate { button.BackColor = danger ? Color.FromArgb(196, 43, 67) : Color.FromArgb(29, 35, 32); button.ForeColor = Color.White; };
            button.MouseLeave += delegate { button.BackColor = Color.Transparent; button.ForeColor = Color.FromArgb(185, 194, 189); };
            button.MouseUp += delegate { if (!IsDisposed) BeginInvoke(new Action(delegate { browser.Focus(); })); };
        }

        private void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            if (WindowState == FormWindowState.Normal && e.Y <= 10)
            {
                ReleaseCapture();
                SendMessage(Handle, 0x00A1, new IntPtr(12), IntPtr.Zero);
                return;
            }
            if (WindowState == FormWindowState.Maximized)
            {
                Point cursor = Cursor.Position;
                double horizontalRatio = titleBar.Width > 0 ? (double)e.X / titleBar.Width : 0.5;
                WindowState = FormWindowState.Normal;
                maximizeButton.Text = "\u25a1";
                Location = new Point(
                    cursor.X - (int)Math.Round(Width * horizontalRatio),
                    cursor.Y - Math.Min(e.Y, titleBar.Height / 2));
            }
            ReleaseCapture();
            SendMessage(Handle, 0x00A1, new IntPtr(2), IntPtr.Zero);
        }

        private void ToggleMaximize()
        {
            UpdateMaximizedBounds();
            WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            maximizeButton.Text = WindowState == FormWindowState.Maximized ? "\u2750" : "\u25a1";
        }

        private void UpdateMaximizedBounds()
        {
            MaximizedBounds = Screen.FromControl(this).WorkingArea;
        }

        protected override void WndProc(ref Message message)
        {
            const int NonClientHitTest = 0x0084;
            if (message.Msg == NonClientHitTest && WindowState == FormWindowState.Normal)
            {
                base.WndProc(ref message);
                Point point = PointToClient(new Point(message.LParam.ToInt32()));
                int grip = 10;
                if (point.X <= grip && point.Y <= grip) message.Result = new IntPtr(13);
                else if (point.X >= ClientSize.Width - grip && point.Y <= grip) message.Result = new IntPtr(14);
                else if (point.X <= grip && point.Y >= ClientSize.Height - grip) message.Result = new IntPtr(16);
                else if (point.X >= ClientSize.Width - grip && point.Y >= ClientSize.Height - grip) message.Result = new IntPtr(17);
                else if (point.X <= grip) message.Result = new IntPtr(10);
                else if (point.X >= ClientSize.Width - grip) message.Result = new IntPtr(11);
                else if (point.Y <= grip) message.Result = new IntPtr(12);
                else if (point.Y >= ClientSize.Height - grip) message.Result = new IntPtr(15);
                return;
            }
            base.WndProc(ref message);
        }

        private async void OnLoaded(object sender, EventArgs e)
        {
            try
            {
                string profile = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Spotify Lite", "WebView2");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await browser.EnsureCoreWebView2Async(environment);

                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
                browser.CoreWebView2.Settings.IsZoomControlEnabled = false;
                browser.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                browser.CoreWebView2.NewWindowRequested += delegate(object source, CoreWebView2NewWindowRequestedEventArgs args)
                {
                    args.Handled = true;
                    try { System.Diagnostics.Process.Start(args.Uri); } catch { }
                };
                browser.Source = new Uri("http://127.0.0.1:" + Port + "/");
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "Spotify Lite n'a pas pu demarrer.\n\n" + error.Message,
                    "Spotify Lite", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            try
            {
                if (args.TryGetWebMessageAsString() != "get-system-usage") return;
                browser.CoreWebView2.PostWebMessageAsJson(SystemUsageMonitor.ReadJson());
            }
            catch { }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (browser != null) browser.Dispose();
            base.OnFormClosed(e);
        }
    }

    private static class SystemUsageMonitor
    {
        private const uint SnapshotProcesses = 0x00000002;
        private static readonly object Sync = new object();
        private static DateTime previousTime = DateTime.UtcNow;
        private static TimeSpan previousCpu = TimeSpan.Zero;
        private static bool hasPreviousSample = false;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct ProcessEntry
        {
            public uint size;
            public uint usage;
            public uint processId;
            public IntPtr defaultHeapId;
            public uint moduleId;
            public uint threads;
            public uint parentProcessId;
            public int basePriority;
            public uint flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executableFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static string ReadJson()
        {
            lock (Sync)
            {
                HashSet<int> ids = GetProcessTree(Process.GetCurrentProcess().Id);
                long memory = 0;
                TimeSpan cpu = TimeSpan.Zero;
                int count = 0;
                foreach (int id in ids)
                {
                    try
                    {
                        using (Process process = Process.GetProcessById(id))
                        {
                            memory += process.WorkingSet64;
                            cpu += process.TotalProcessorTime;
                            count++;
                        }
                    }
                    catch { }
                }

                DateTime now = DateTime.UtcNow;
                double elapsed = Math.Max(0.001, (now - previousTime).TotalSeconds);
                double cpuPercent = hasPreviousSample
                    ? Math.Max(0, (cpu - previousCpu).TotalSeconds / elapsed / Environment.ProcessorCount * 100)
                    : 0;
                previousTime = now;
                previousCpu = cpu;
                hasPreviousSample = true;
                return String.Format(CultureInfo.InvariantCulture,
                    "{{\"type\":\"system-usage\",\"cpu\":{0:0.0},\"memoryMb\":{1:0.0},\"processes\":{2}}}",
                    cpuPercent, memory / 1048576.0, count);
            }
        }

        private static HashSet<int> GetProcessTree(int rootId)
        {
            Dictionary<int, List<int>> children = new Dictionary<int, List<int>>();
            IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
            if (snapshot != new IntPtr(-1))
            {
                ProcessEntry entry = new ProcessEntry();
                entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                if (Process32First(snapshot, ref entry))
                {
                    do
                    {
                        int parent = unchecked((int)entry.parentProcessId);
                        List<int> list;
                        if (!children.TryGetValue(parent, out list)) children[parent] = list = new List<int>();
                        list.Add(unchecked((int)entry.processId));
                    } while (Process32Next(snapshot, ref entry));
                }
                CloseHandle(snapshot);
            }

            HashSet<int> result = new HashSet<int>();
            Queue<int> pending = new Queue<int>();
            pending.Enqueue(rootId);
            while (pending.Count > 0)
            {
                int id = pending.Dequeue();
                if (!result.Add(id)) continue;
                List<int> childIds;
                if (!children.TryGetValue(id, out childIds)) continue;
                foreach (int child in childIds) pending.Enqueue(child);
            }
            return result;
        }
    }
}
