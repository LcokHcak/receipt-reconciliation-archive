using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace TicketWorkbenchLauncher
{
    internal static class Program
    {
        private const string DefaultHost = "127.0.0.1";
        private const string DefaultPort = "3218";

        [STAThread]
        private static int Main()
        {
            string appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string host = FirstNonEmpty(Environment.GetEnvironmentVariable("WORKBENCH_HOST"), DefaultHost);
            string port = FirstNonEmpty(Environment.GetEnvironmentVariable("WORKBENCH_PORT"), DefaultPort);
            string baseUrl = "http://" + host + ":" + port;
            string healthUrl = baseUrl + "/api/health";
            string appUrl = baseUrl + "/app/";
            string serverScript = Path.Combine(appRoot, "passport_review_workbench.js");
            string bundledNode = Path.Combine(appRoot, "runtime", "node", "node.exe");
            string nodeExe = File.Exists(bundledNode) ? bundledNode : "node";

            if (!File.Exists(serverScript))
            {
                ShowError("Cannot find the server file:\n" + serverScript + "\n\nKeep TicketWorkbench.exe inside the complete portable package folder.");
                return 1;
            }
            PreparePortablePython(appRoot);

            try
            {
                if (!IsHealthy(healthUrl))
                {
                    StartServer(nodeExe, serverScript, appRoot, host, port);
                }

                if (!WaitForHealthy(healthUrl, TimeSpan.FromSeconds(45)))
                {
                    ShowError("The service did not become ready in time.\n\nCheck that this folder is not blocked and that port 3218 is available.");
                    return 2;
                }

                OpenBrowser(appUrl);
                return 0;
            }
            catch (Exception error)
            {
                ShowError("Startup failed:\n" + error.Message);
                return 3;
            }
        }

        private static string FirstNonEmpty(string value, string fallback)
        {
            return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        }

        private static void PreparePortablePython(string appRoot)
        {
            string bundledPythonHome = Path.Combine(appRoot, "runtime", "python310");
            if (!Directory.Exists(bundledPythonHome))
            {
                return;
            }

            RewriteVenvConfig(Path.Combine(appRoot, "_pdx_runtime", "pyvenv.cfg"), bundledPythonHome);
            RewriteVenvConfig(Path.Combine(appRoot, "paddleocr_standalone", ".venv", "pyvenv.cfg"), bundledPythonHome);
        }

        private static void RewriteVenvConfig(string configPath, string pythonHome)
        {
            if (!File.Exists(configPath))
            {
                return;
            }

            string[] existingLines = File.ReadAllLines(configPath);
            List<string> lines = new List<string>();
            bool wroteHome = false;
            bool wroteSystemSitePackages = false;
            bool wroteVersion = false;

            foreach (string line in existingLines)
            {
                string trimmed = line.TrimStart();
                if (trimmed.StartsWith("home =", StringComparison.OrdinalIgnoreCase))
                {
                    lines.Add("home = " + pythonHome);
                    wroteHome = true;
                }
                else if (trimmed.StartsWith("include-system-site-packages =", StringComparison.OrdinalIgnoreCase))
                {
                    lines.Add("include-system-site-packages = false");
                    wroteSystemSitePackages = true;
                }
                else if (trimmed.StartsWith("version =", StringComparison.OrdinalIgnoreCase))
                {
                    lines.Add(line);
                    wroteVersion = true;
                }
                else
                {
                    lines.Add(line);
                }
            }

            if (!wroteHome)
            {
                lines.Insert(0, "home = " + pythonHome);
            }
            if (!wroteSystemSitePackages)
            {
                lines.Add("include-system-site-packages = false");
            }
            if (!wroteVersion)
            {
                lines.Add("version = 3.10.11");
            }

            File.WriteAllLines(configPath, lines.ToArray());
        }

        private static void StartServer(string nodeExe, string serverScript, string appRoot, string host, string port)
        {
            string bundledPaddlexPython = Path.Combine(appRoot, "_pdx_runtime", "Scripts", "python.exe");
            string bundledPaddleOcrPython = Path.Combine(appRoot, "paddleocr_standalone", ".venv", "Scripts", "python.exe");
            string bundledTemplate = Path.Combine(appRoot, "passport_review_workbench", "templates", "customer-receipt-template.xlsx");
            string bundledPythonHome = Path.Combine(appRoot, "runtime", "python310");
            string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            string portablePath = string.Join(Path.PathSeparator.ToString(), new[]
            {
                bundledPythonHome,
                Path.GetDirectoryName(bundledPaddlexPython) ?? "",
                Path.Combine(appRoot, "_pdx_runtime", "Library", "bin"),
                Path.GetDirectoryName(bundledPaddleOcrPython) ?? "",
                currentPath
            });

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverScript + "\"",
                WorkingDirectory = appRoot,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            startInfo.EnvironmentVariables["WORKBENCH_HOST"] = host;
            startInfo.EnvironmentVariables["WORKBENCH_PORT"] = port;
            startInfo.EnvironmentVariables["HOST"] = host;
            startInfo.EnvironmentVariables["PORT"] = port;
            startInfo.EnvironmentVariables["PATH"] = portablePath;
            if (File.Exists(bundledPaddlexPython))
            {
                startInfo.EnvironmentVariables["SIGN_PADDLEX_PYTHON_EXE"] = bundledPaddlexPython;
            }
            if (File.Exists(bundledTemplate))
            {
                startInfo.EnvironmentVariables["CUSTOMER_RECEIPT_TEMPLATE_PATH"] = bundledTemplate;
            }

            Process process = Process.Start(startInfo);
            if (process == null)
            {
                throw new InvalidOperationException("Could not start the local service.");
            }
        }

        private static bool WaitForHealthy(string healthUrl, TimeSpan timeout)
        {
            DateTime deadline = DateTime.UtcNow.Add(timeout);
            while (DateTime.UtcNow < deadline)
            {
                if (IsHealthy(healthUrl))
                {
                    return true;
                }

                Thread.Sleep(750);
            }

            return false;
        }

        private static bool IsHealthy(string healthUrl)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(healthUrl);
                request.Method = "GET";
                request.Timeout = 2000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return ((int)response.StatusCode >= 200 && (int)response.StatusCode < 300);
                }
            }
            catch
            {
                return false;
            }
        }

        private static void OpenBrowser(string url)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }

        private static void ShowError(string message)
        {
            MessageBox.Show(message, "Ticket Workbench", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
