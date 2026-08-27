<#
    Envia un archivo de bytes CRUDOS a una cola de impresion de Windows.

    Blueprint v0.2 - docs/architecture/03-auth-impresion-config.md 2.1

    Por que P/Invoke y no Out-Printer: Out-Printer pasa por el driver, que reinterpreta
    el contenido como texto o graficos y destruye los comandos ESC/POS. La unica forma
    de que los bytes lleguen intactos a la termica es abrir la cola con el datatype RAW
    contra winspool.drv, que es lo que hace este script.

    Uso:  powershell -File raw-print.ps1 -PrinterName "ENDURO" -FilePath "C:\...\job.bin"
    Modo sonda (no imprime, solo verifica que la cola existe y abre):  -Probe
#>
param(
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [string]$FilePath,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, DOCINFO di);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static void Send(string printerName, byte[] bytes) {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter fallo: " + Marshal.GetLastWin32Error());

        try {
            DOCINFO di = new DOCINFO();
            di.pDocName = "Donaji ESC/POS";
            di.pDataType = "RAW";

            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("StartDocPrinter fallo: " + Marshal.GetLastWin32Error());
            try {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter fallo: " + Marshal.GetLastWin32Error());
                try {
                    IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
                    try {
                        Marshal.Copy(bytes, 0, buf, bytes.Length);
                        int written;
                        if (!WritePrinter(hPrinter, buf, bytes.Length, out written))
                            throw new Exception("WritePrinter fallo: " + Marshal.GetLastWin32Error());
                        if (written != bytes.Length)
                            throw new Exception("Escritura parcial: " + written + " de " + bytes.Length);
                    } finally { Marshal.FreeCoTaskMem(buf); }
                } finally { EndPagePrinter(hPrinter); }
            } finally { EndDocPrinter(hPrinter); }
        } finally { ClosePrinter(hPrinter); }
    }

    public static void Probe(string printerName) {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter fallo: " + Marshal.GetLastWin32Error());
        ClosePrinter(hPrinter);
    }
}
'@

if ($Probe) {
    [RawPrinter]::Probe($PrinterName)
    Write-Output 'PROBE_OK'
    exit 0
}

if (-not $FilePath) { throw 'Falta -FilePath' }
if (-not (Test-Path -LiteralPath $FilePath)) { throw "No existe el archivo: $FilePath" }

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinter]::Send($PrinterName, $bytes)
Write-Output ("SENT_OK " + $bytes.Length)
