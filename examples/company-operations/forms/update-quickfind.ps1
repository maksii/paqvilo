param([Parameter(Mandatory=$true)][string]$InputZip,[Parameter(Mandatory=$true)][string]$OutputZip,[Parameter(Mandatory=$true)][string]$Adjustments)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if(Test-Path -LiteralPath $OutputZip){throw 'Output archive already exists; refusing overwrite.'}
$updates=Get-Content -LiteralPath $Adjustments -Raw|ConvertFrom-Json
$inputArchive=[System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($InputZip))
$outputArchive=[System.IO.Compression.ZipFile]::Open([System.IO.Path]::GetFullPath($OutputZip),[System.IO.Compression.ZipArchiveMode]::Create)
try{
 $changed=0
 foreach($entry in $inputArchive.Entries){
  $newEntry=$outputArchive.CreateEntry($entry.FullName,[System.IO.Compression.CompressionLevel]::Optimal)
  $source=$entry.Open();$destination=$newEntry.Open()
  try{
   if($entry.FullName -ne 'customizations.xml'){$source.CopyTo($destination);continue}
   $reader=[System.IO.StreamReader]::new($source,[System.Text.Encoding]::UTF8);$text=$reader.ReadToEnd();$document=[System.Xml.XmlDocument]::new();$document.PreserveWhitespace=$true;$document.LoadXml($text)
   foreach($update in $updates){
    $matches=@($document.SelectNodes('//savedquery')|Where-Object{$_.savedqueryid -and ([string]$_.savedqueryid).Trim('{}').ToLowerInvariant() -eq $update.id})
    if($matches.Count -ne 1){throw "Expected one exported savedquery for $($update.id), found $($matches.Count)."}
    $query=$matches[0];if([string]$query.querytype -ne '4'){throw 'Refusing to modify a non-Quick Find query.'}
    $fetch=[System.Xml.XmlDocument]::new();$fetch.LoadXml($update.fetchXml);$layout=[System.Xml.XmlDocument]::new();$layout.LoadXml($update.layoutXml)
    $fetchElement=$query.SelectSingleNode('fetchxml');$layoutElement=$query.SelectSingleNode('layoutxml');if(!$fetchElement -or !$layoutElement){throw 'Exported view structure differs; refusing guessed edits.'}
    $fetchElement.RemoveAll();[void]$fetchElement.AppendChild($document.ImportNode($fetch.DocumentElement,$true));$layoutElement.RemoveAll();[void]$layoutElement.AppendChild($document.ImportNode($layout.DocumentElement,$true));$changed++
   }
   $encoding=[System.Text.UTF8Encoding]::new($false);$writer=[System.IO.StreamWriter]::new($destination,$encoding);$document.Save($writer);$writer.Flush()
  }finally{$source.Dispose();$destination.Dispose()}
 }
 if($changed -ne @($updates).Count){throw 'Quick Find edit inventory was incomplete.'}
 Write-Output (ConvertTo-Json @{changed=$changed;output=$OutputZip} -Compress)
}finally{$inputArchive.Dispose();$outputArchive.Dispose()}
