param(
    [Parameter(Mandatory=$true)][string]$ProjectFile,
    [string]$Configuration = '',
    [string]$Platform = '',
    [string]$HostArchitecture = 'x64',
    [string]$InstancePath = '',
    [string]$InstanceVersion = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$privateDiagnostics = New-Object System.Collections.Generic.List[object]
$compileFields = @('FullPath','AdditionalIncludeDirectories','PreprocessorDefinitions','UndefinePreprocessorDefinitions','UndefineAllPreprocessorDefinitions',
    'ForcedIncludeFiles','LanguageStandard','LanguageStandard_C','CompileAs','ExceptionHandling','RuntimeLibrary','RuntimeTypeInfo','AdditionalOptions','ExcludedFromBuild',
    'IgnoreStandardIncludePath','PrecompiledHeader','PrecompiledHeaderFile','TreatWChar_tAsBuiltInType','EnableEnhancedInstructionSet','StructMemberAlignment','CallingConvention',
    'CompileAsManaged','FloatingPointModel','ConformanceMode','SupportJustMyCode','UseFullPaths','ExternalIncludePath','AdditionalExternalIncludeDirectories')

function Complete-Result($value) {
    [Console]::WriteLine(($value | ConvertTo-Json -Depth 12 -Compress))
    exit 0
}

function Failure([string]$status, [string]$code, [string]$message) {
    Complete-Result ([ordered]@{ status=$status; diagnostics=@(@{code=$code;message=$message}) })
}

function Initialize-SelectedEnvironment([string]$vsRoot, [string]$architecture, [string]$toolset, [string]$sdk) {
    $vcvars = Join-Path $vsRoot 'VC/Auxiliary/Build/vcvarsall.bat'
    if (!(Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw 'missing_vcvars' }
    $arguments = $architecture
    if ($sdk) {
        if ($sdk -notmatch '^(8\.1|10\.0\.\d+\.\d+)$') { throw 'unsupported_sdk' }
        $arguments += ' ' + $sdk
    }
    if ($toolset) {
        $version = switch -Regex ($toolset) {
            '^v141(_xp)?$' { '14.1'; break }
            '^v142$' { '14.2'; break }
            '^v143$' { '14.3'; break }
            '^v145$' { '14.5'; break }
            default { throw 'unsupported_toolset' }
        }
        if ($toolset -match '_xp$') { throw 'unsupported_xp_toolset' }
        $arguments += ' -vcvars_ver=' + $version
    }
    # Read only allowlisted variables needed by the toolchain; do not enumerate the whole environment with set/Get-ChildItem Env:.
    $names = @('Path','INCLUDE','LIB','LIBPATH','VSINSTALLDIR','VCINSTALLDIR','VCToolsInstallDir','VCToolsVersion',
        'WindowsSdkDir','WindowsSDKVersion','WindowsSdkBinPath','WindowsSdkVerBinPath','UniversalCRTSdkDir','UCRTVersion',
        'WindowsSdkDir_10','WindowsSdkDir_81','ExtensionSdkDir','VisualStudioVersion','VSCMD_ARG_HOST_ARCH','VSCMD_ARG_TGT_ARCH')
    $quotedNames = ($names | ForEach-Object { "'" + $_ + "'" }) -join ','
    $capture = '$values=[ordered]@{};foreach($name in @(' + $quotedNames + ')){$values[$name]=[Environment]::GetEnvironmentVariable($name)};[Console]::WriteLine(($values|ConvertTo-Json -Compress))'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($capture))
    $nativePs = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # Use paths from vswhere; reject cmd metacharacters and never interpolate project settings into a command string.
    if ($vcvars -match '[%"\r\n&|<>^]') { throw 'unsafe_toolchain_path' }
    $command = 'call "' + $vcvars + '" ' + $arguments + ' >nul && "' + $nativePs + '" -NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $lines = @(& $env:ComSpec /d /c $command 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'vcvars_failed' }
    $values = ($lines -join "`n") | ConvertFrom-Json
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, [string]$values.$name, 'Process')
    }
    return $names
}

function New-Evaluation([string]$enginePath, [string]$toolsVersion, [string]$vsRoot, [string]$vsVersion, [string]$configuration, [string]$platform) {
    $properties = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    if ($configuration) { $properties['Configuration'] = $configuration }
    if ($platform) { $properties['Platform'] = $platform }
    $properties['VisualStudioVersion'] = $vsVersion
    $properties['VSInstallDir'] = $vsRoot.TrimEnd('\','/') + '\'
    $properties['VCInstallDir'] = [Environment]::GetEnvironmentVariable('VCINSTALLDIR')
    $properties['VCToolsInstallDir'] = [Environment]::GetEnvironmentVariable('VCToolsInstallDir')
    $properties['VCToolsVersion'] = [Environment]::GetEnvironmentVariable('VCToolsVersion')
    $targetCandidates = @(
        (Join-Path $vsRoot 'Common7/IDE/VC/VCTargets'),
        (Join-Path $vsRoot ('MSBuild/Microsoft/VC/v' + $vsVersion.Replace('.','')))
    )
    $target = $targetCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'Microsoft.Cpp.Default.props') } | Select-Object -First 1
    if (!$target) { throw 'missing_vc_targets' }
    $properties['VCTargetsPath'] = $target.TrimEnd('\','/') + '\'
    # The API host is not MSBuild.exe: provide the instance path normally set by the executable to avoid an incorrect \VC\Tools default.
    foreach ($name in @('WindowsSdkDir','WindowsSDKVersion','UniversalCRTSdkDir','UCRTVersion','WindowsSdkDir_10','WindowsSdkDir_81','ExtensionSdkDir')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $properties[$name] = $value }
    }
    $collection = New-Object Microsoft.Build.Evaluation.ProjectCollection
    $collection.AddToolset((New-Object Microsoft.Build.Evaluation.Toolset($toolsVersion, $enginePath, $collection, $null)))
    try {
        # LoadProject is the only project entry point; do not create BuildManager or run any Target, Task, or custom build.
        $project = $collection.LoadProject($ProjectFile, $properties, $toolsVersion)
        return @{ collection=$collection; project=$project }
    } catch { $collection.Dispose(); throw }
}

function Get-ImportProbeState([string]$kind, [string]$pattern) {
    if ($kind -eq 'path') {
        if (Test-Path -LiteralPath $pattern -PathType Leaf) { return ,@('file') }
        if (Test-Path -LiteralPath $pattern -PathType Container) { return ,@('directory') }
        return ,@('missing')
    }
    $files = @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Replace('\','/').ToLowerInvariant() } | Sort-Object)
    return ,$files
}

function Test-EvaluationElement($element) {
    $ancestor = $element
    while ($ancestor) {
        if ($ancestor.GetType().Name -eq 'ProjectTargetElement') { return $false }
        $ancestor = $ancestor.Parent
    }
    return $true
}

function Get-ImportProbes($project) {
    $probes = New-Object System.Collections.Generic.List[object]
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    $reusable = $true
    $uncertainties = New-Object System.Collections.Generic.List[object]
    $markUncertain = { param($element, $reason)
        if ($uncertainties.Count -lt 32) { $uncertainties.Add([ordered]@{ file=$element.ContainingProject.FullPath; line=$element.Location.Line; reason=$reason; expression=$element.OuterElement }) }
    }
    $roots = @($project.Xml) + @($project.Imports | ForEach-Object { $_.ImportedProject })
    # Track only the property closure affecting Import or ClCompile; unrelated SDK or build-target properties do not change the compilation database.
    $relevant = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('IncludePath','CharacterSet')) { [void]$relevant.Add($name) }
    $elements = New-Object System.Collections.Generic.HashSet[object]
    $addReferences = { param([string]$text)
        foreach ($reference in [regex]::Matches($text, '\$\(([A-Za-z_][A-Za-z0-9_]*)(?=[.)])')) { [void]$relevant.Add($reference.Groups[1].Value) }
    }
    foreach ($root in $roots) { foreach ($element in $root.AllChildren) {
        if (!(Test-EvaluationElement $element)) { continue }
        if ($element.GetType().Name -eq 'ProjectImportElement' -or
            ($element.GetType().Name -in @('ProjectItemElement','ProjectItemDefinitionElement') -and $element.ItemType -eq 'ClCompile')) {
            [void]$elements.Add($element)
            if ($element.GetType().Name -eq 'ProjectImportElement') { & $addReferences $element.OuterElement }
            else {
                & $addReferences ($element.Condition + ' ' + $element.Include + ' ' + $element.Exclude + ' ' + $element.Remove)
                foreach ($descendant in $element.AllChildren) {
                    if ($descendant.Name -in $compileFields) { [void]$elements.Add($descendant); & $addReferences $descendant.OuterElement }
                }
            }
        }
    } }
    do {
        $oldCount = $relevant.Count
        foreach ($root in $roots) { foreach ($element in $root.AllChildren) {
            if (!(Test-EvaluationElement $element)) { continue }
            if ($element.GetType().Name -eq 'ProjectPropertyElement' -and $relevant.Contains($element.Name)) {
                [void]$elements.Add($element); & $addReferences $element.OuterElement
            }
        } }
        foreach ($element in @($elements | ForEach-Object { $_ })) {
            $parent = $element.Parent
            while ($parent) { [void]$elements.Add($parent); & $addReferences $parent.Condition; $parent = $parent.Parent }
        }
    } while ($oldCount -ne $relevant.Count)
    # Allow only pure CLR string predicates; nested unknown functions retain the $([ marker and disable cache reuse.
    $removePureFunctions = { param([string]$text)
        $text = [regex]::Replace($text, '(?i)\$\(\[System\.String\]::(?:IsNullOrEmpty|IsNullOrWhiteSpace)\(', '(')
        $text = [regex]::Replace($text, '(?i)\$\(\[System\.IO\.Path\]::Combine\(', '(')
        if ($script:stableVisualStudioContext) { $text = $text.Replace('$([MSBuild]::IsRunningFromVisualStudio())', 'true') }
        return $text
    }
    foreach ($root in $roots) {
        $directory = [IO.Path]::GetDirectoryName($root.FullPath)
        foreach ($import in $root.AllChildren) {
            if (!$elements.Contains($import)) { continue }
            # Track evaluation only. Target and Task conditions do not run, so build-stage files cannot invalidate this cache.
            if (!(Test-EvaluationElement $import)) { continue }
            # The Construction API retains Imports with false conditions; Imports contains only actual imports. Neither substitutes for the other.
            $condition = [string]$import.Condition
            $expressions = @()
            if ($import.GetType().Name -eq 'ProjectImportElement') { $expressions += $import.Project }
            if ($import.GetType().Name -eq 'ProjectItemElement') {
                # Changes to Include/Exclude/Remove membership affect translation units; contents of existing source files are not part of the snapshot.
                foreach ($itemExpression in @($import.Include,$import.Exclude,$import.Remove)) {
                    foreach ($entry in ([string]$itemExpression -split ';')) { if ($entry) { $expressions += $entry } }
                }
            }
            foreach ($match in [regex]::Matches($condition, '(?i)Exists\s*\(\s*([''"])(.*?)\1\s*\)')) { $expressions += $match.Groups[2].Value }
            $conditionToCheck = & $removePureFunctions $condition
            # StartsWith is a pure string condition in standard targets; permit it only for condition checks, while instance methods in paths remain uncached.
            $conditionToCheck = [regex]::Replace($conditionToCheck, '\$\([A-Za-z_][A-Za-z0-9_]*\.StartsWith\(', '(')
            if ($conditionToCheck -match '\$\(\[|\$\([A-Za-z_][A-Za-z0-9_]*\.' -or ($import.GetType().Name -eq 'ProjectImportElement' -and $conditionToCheck -match '@\(|%\(')) { $reusable = $false; & $markUncertain $import 'dynamic_condition' }
            if ($import.GetType().Name -eq 'ProjectPropertyElement') {
                $observedAssignment = $false; $assigned = $project.GetProperty($import.Name)
                while ($assigned) { if ($assigned.Xml -eq $import) { $observedAssignment = $true }; $assigned = $assigned.Predecessor }
                if ($observedAssignment) {
                    $valueToCheck = & $removePureFunctions $import.Value
                    # Upward directory search is a common MSBuild filesystem function; record every ancestor candidate, not only the current match.
                    foreach ($search in [regex]::Matches($import.Value, '(?i)\$\(\[MSBuild\]::GetDirectoryNameOfFileAbove\((.*?)\)\)')) {
                        $arguments = $search.Groups[1].Value -split ','
                        if ($arguments.Count -ne 2) { continue }
                        $startExpression = $arguments[0].Trim().Trim("'",'"')
                        $leafExpression = $arguments[1].Trim().Trim("'",'"')
                        $stableArguments = $true
                        foreach ($reference in [regex]::Matches($startExpression + $leafExpression, '\$\(([A-Za-z_][A-Za-z0-9_]*)\)')) {
                            if ($reference.Groups[1].Value -ieq 'MSBuildThisFileDirectory') { continue }
                            $argumentProperty = $project.GetProperty($reference.Groups[1].Value)
                            $argumentValues = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::Ordinal)
                            while ($argumentProperty) { [void]$argumentValues.Add($argumentProperty.EvaluatedValue); $argumentProperty = $argumentProperty.Predecessor }
                            if ($argumentValues.Count -gt 1) { $stableArguments = $false }
                        }
                        if (!$stableArguments) { continue }
                        $startExpression = [regex]::Replace($startExpression, '(?i)\$\(MSBuildThisFileDirectory\)', [Text.RegularExpressions.MatchEvaluator]{ param($m) $directory.TrimEnd('\','/') + '\' })
                        $start = $project.ExpandString($startExpression); $leaf = $project.ExpandString($leafExpression)
                        if (!$start -or !$leaf -or $leaf -match '[\\/*?;]' -or $start -match '\$\(') { continue }
                        try {
                            $ancestor = [IO.Path]::GetFullPath($start)
                            while ($ancestor) {
                                $pattern = Join-Path $ancestor $leaf
                                if ($seen.Add('path|' + $pattern)) { $probes.Add([ordered]@{kind='path';pattern=$pattern;state=(Get-ImportProbeState 'path' $pattern)}) }
                                $ancestor = [IO.Path]::GetDirectoryName($ancestor.TrimEnd('\','/'))
                            }
                            $valueToCheck = $valueToCheck.Replace($search.Value, '')
                        } catch { }
                    }
                    if ($valueToCheck -match '\$\(\[|\$\([A-Za-z_][A-Za-z0-9_]*\.') { $reusable = $false; & $markUncertain $import 'dynamic_input_property' }
                }
            }
            if ($import.GetType().Name -eq 'ProjectMetadataElement' -and ((& $removePureFunctions $import.Value) -match '\$\(\[|\$\([A-Za-z_][A-Za-z0-9_]*\.')) {
                $reusable = $false; & $markUncertain $import 'dynamic_compile_metadata'
            }
            foreach ($expression in $expressions) {
                if ($expression -match '\$\(\[|\$\([A-Za-z_][A-Za-z0-9_]*\.|@\(|%\(|\*\*') { $reusable = $false; & $markUncertain $import 'dynamic_path_expression'; continue }
                $contextValues = @{ MSBuildThisFileDirectory=$directory.TrimEnd('\','/') + '\'; MSBuildThisFileFullPath=$root.FullPath; MSBuildThisFile=[IO.Path]::GetFileName($root.FullPath); MSBuildThisFileName=[IO.Path]::GetFileNameWithoutExtension($root.FullPath); MSBuildThisFileExtension=[IO.Path]::GetExtension($root.FullPath) }
                $contextExpression = [regex]::Replace($expression, '(?i)\$\((MSBuildThisFileDirectory|MSBuildThisFileFullPath|MSBuildThisFile|MSBuildThisFileName|MSBuildThisFileExtension)\)', [Text.RegularExpressions.MatchEvaluator]{ param($m) $contextValues[$m.Groups[1].Value] })
                $variants = @($contextExpression)
                # Use the API’s actual property-assignment chain to enumerate bounded candidates. Do not reimplement macro inheritance or treat the final value as the value at import time.
                foreach ($match in [regex]::Matches($expression, '\$\(([A-Za-z_][A-Za-z0-9_]*)\)')) {
                    $name = $match.Groups[1].Value
                    if ($name -in @('MSBuildThisFileDirectory','MSBuildThisFileFullPath','MSBuildThisFile','MSBuildThisFileName','MSBuildThisFileExtension')) { continue }
                    $property = $project.GetProperty($name)
                    $values = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::Ordinal)
                    if (!$property) { [void]$values.Add('') }
                    while ($property) {
                        [void]$values.Add($property.EvaluatedValue)
                        if ((& $removePureFunctions $property.UnevaluatedValue) -match '\$\(\[|\$\([A-Za-z_][A-Za-z0-9_]*\.') { $reusable = $false; & $markUncertain $import ('dynamic_property_function:' + $name) }
                        $property = $property.Predecessor
                    }
                    $newVariants = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::Ordinal)
                    foreach ($variant in $variants) { foreach ($value in $values) { [void]$newVariants.Add($variant.Replace('$(' + $name + ')', $value)) } }
                    if ($newVariants.Count -gt 64) { $reusable = $false; & $markUncertain $import 'property_variant_limit'; break }
                    $variants = @($newVariants | ForEach-Object { $_ })
                }
                foreach ($variant in $variants) {
                $expanded = $project.ExpandString($variant)
                if (!$expanded) { continue }
                if ($expanded -match '\$\(|@\(|%\(|;|\*\*|\[|\]') { $reusable = $false; continue }
                try {
                    # ItemSpec is relative to the main project; imported props do not change the base directory for ClCompile Include.
                    $baseDirectory = if ($import.GetType().Name -eq 'ProjectItemElement') { $project.DirectoryPath } else { $directory }
                    $pattern = if ([IO.Path]::IsPathRooted($expanded)) { $expanded } else { Join-Path $baseDirectory $expanded }
                    # .NET Framework GetFullPath rejects wildcards; normalize only the path portion, then restore the wildcard.
                    $pattern = [IO.Path]::GetFullPath($pattern.Replace('*','__CODEMAP_IMPORT_STAR__').Replace('?','__CODEMAP_IMPORT_QUESTION__')).Replace('__CODEMAP_IMPORT_STAR__','*').Replace('__CODEMAP_IMPORT_QUESTION__','?')
                } catch { $reusable = $false; continue }
                $kind = if ($pattern -match '[*?]') { 'glob' } else { 'path' }
                if ($seen.Add($kind + '|' + $pattern)) {
                    $state = Get-ImportProbeState $kind $pattern
                    if ($state.Count -gt 8192 -or $probes.Count -ge 2048) { $reusable = $false; continue }
                    $probes.Add([ordered]@{ kind=$kind; pattern=$pattern; state=$state })
                }
                }
            }
        }
    }
    return @{ probes=@($probes.ToArray() | Sort-Object { $_.kind + '|' + $_.pattern }); reusable=$reusable; uncertainties=$uncertainties.ToArray() }
}

function Get-InputSnapshot($project, $toolchainFiles) {
    $files = @($project.FullPath) + @($project.Imports | ForEach-Object { $_.ImportedProject.FullPath }) + @($toolchainFiles)
    return ,@($files | Sort-Object -Unique | ForEach-Object {
        [ordered]@{ file=$_; digest=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}

try {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { Failure 'missing_tool' 'native_powershell_required' 'MSBuild evaluation requires native Windows PowerShell 5.' }
    $ProjectFile = (Resolve-Path -LiteralPath $ProjectFile).Path
    if (!$InstancePath) {
        $vswhereCandidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft Visual Studio/Installer/vswhere.exe')
        )
        $vswhereCommand = Get-Command vswhere.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($vswhereCommand) { $vswhereCandidates += $vswhereCommand.Source }
        $vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if (!$vswhere) { Failure 'missing_tool' 'missing_vswhere' 'System vswhere was not found.' }
        $instanceJson = @(& $vswhere -all -products '*' -prerelease -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8)
        if ($LASTEXITCODE -ne 0) { Failure 'missing_tool' 'vswhere_failed' 'vswhere could not enumerate Visual Studio C++ instances.' }
        $instances = @((($instanceJson -join "`n") | ConvertFrom-Json) | Sort-Object { [version]$_.installationVersion } -Descending)
        if (!$instances.Count) { Failure 'missing_tool' 'missing_visual_studio' 'No Visual Studio instance with C++ tools was found.' }
        $nativePs = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $last = $null
        foreach ($instance in $instances) {
            # Use a separate native process per instance to avoid mixing Microsoft.Build versions.
            $childArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,
                '-ProjectFile',$ProjectFile,'-HostArchitecture',$HostArchitecture,'-InstancePath',$instance.installationPath,
                '-InstanceVersion',$instance.installationVersion)
            if ($Configuration) { $childArguments += @('-Configuration',$Configuration) }
            if ($Platform) { $childArguments += @('-Platform',$Platform) }
            $lines = @(& $nativePs @childArguments 2>$null)
            if ($LASTEXITCODE -ne 0) { continue }
            try { $last = ($lines -join "`n") | ConvertFrom-Json } catch { continue }
            if ($last.status -eq 'ready') { Complete-Result $last }
            if ($last.status -eq 'invalid' -or $last.status -eq 'ambiguous') { Complete-Result $last }
        }
        if ($last) { Complete-Result $last }
        Failure 'missing_tool' 'no_matching_toolchain' 'No Visual Studio instance satisfies the project toolset and SDK.'
    }
    $vsMajor = ([version]$InstanceVersion).Major
    $vsVersion = [string]$vsMajor + '.0'
    $toolsVersion = if ($vsMajor -eq 15) { '15.0' } else { 'Current' }
    $engine = if ($vsMajor -eq 15) { Join-Path $InstancePath 'MSBuild/15.0/Bin' } else { Join-Path $InstancePath 'MSBuild/Current/Bin' }
    if (!(Test-Path -LiteralPath (Join-Path $engine 'Microsoft.Build.dll'))) { throw 'missing_msbuild' }
    # Pin the host instance context so an external MSBUILD_EXE_PATH cannot make the same assembly use a different installation.
    [Environment]::SetEnvironmentVariable('MSBUILD_EXE_PATH', (Join-Path $engine 'MSBuild.exe'), 'Process')
    # Outside MSBuild.exe there are no binding redirects, so MSBuild's own dependencies (for example System.Collections.Immutable)
    # are resolved from the selected engine directory by name, like Microsoft.Build.Locator does. A compiled handler is used
    # because a script-block handler fails when the runtime raises the event on a thread without a runspace.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class CodemapMSBuildAssemblyResolver {
    private static string directory;
    public static void Register(string engineDirectory) {
        directory = engineDirectory;
        AppDomain.CurrentDomain.AssemblyResolve += Resolve;
    }
    private static Assembly Resolve(object sender, ResolveEventArgs args) {
        string candidate = Path.Combine(directory, new AssemblyName(args.Name).Name + ".dll");
        return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
    }
}
'@
    [CodemapMSBuildAssemblyResolver]::Register($engine)
    foreach ($assembly in @('Microsoft.Build.Framework.dll','Microsoft.Build.Utilities.Core.dll','Microsoft.Build.dll')) {
        [void][Reflection.Assembly]::LoadFrom((Join-Path $engine $assembly))
    }
    $initialArchitecture = if ($HostArchitecture -eq 'arm64') { 'amd64_arm64' } elseif ($HostArchitecture -eq 'ia32') { 'x86' } else { 'amd64' }
    $environmentNames = Initialize-SelectedEnvironment $InstancePath $initialArchitecture '' ''
    $evaluation = New-Evaluation $engine $toolsVersion $InstancePath $vsVersion '' ''
    try {
        $declared = @($evaluation.project.GetItems('ProjectConfiguration') | ForEach-Object {
            @{ configuration=$_.GetMetadataValue('Configuration'); platform=$_.GetMetadataValue('Platform') }
        })
    } finally { $evaluation.collection.UnloadAllProjects(); $evaluation.collection.Dispose() }
    if (!$declared.Count) { Failure 'unsupported' 'no_declared_configuration' 'The VC++ project declares no ProjectConfiguration.' }
    $hostPlatform = if ($HostArchitecture -eq 'arm64') { 'ARM64' } elseif ($HostArchitecture -eq 'ia32') { 'Win32' } else { 'x64' }
    $matching = @($declared | Where-Object { (!$Configuration -or $_.configuration -eq $Configuration) -and (!$Platform -or $_.platform -eq $Platform) })
    if (!$matching.Count) { Failure 'invalid' 'undeclared_configuration' 'The selected configuration/platform is not declared in the project.' }
    $preferredPlatform = if ($Platform) { $Platform } else { $hostPlatform }
    $preferredConfiguration = if ($Configuration) { $Configuration } else { 'Release' }
    $selected = $matching | Where-Object { $_.configuration -eq $preferredConfiguration -and $_.platform -eq $preferredPlatform } | Select-Object -First 1
    if (!$selected) { $selected = $matching | Select-Object -First 1 }
    $Configuration = $selected.configuration
    $Platform = $selected.platform
    $architecture = switch ($Platform) { 'Win32' {'x86'} 'x64' {'amd64'} 'ARM64' {'amd64_arm64'} 'ARM' {'amd64_arm'} default { throw 'unsupported_platform' } }
    $evaluation = New-Evaluation $engine $toolsVersion $InstancePath $vsVersion $Configuration $Platform
    try {
        $toolset = $evaluation.project.GetPropertyValue('PlatformToolset')
        $sdk = $evaluation.project.GetPropertyValue('WindowsTargetPlatformVersion')
    } finally { $evaluation.collection.UnloadAllProjects(); $evaluation.collection.Dispose() }
    if (!$toolset -or !$sdk) { throw 'missing_toolset_or_sdk' }
    $environmentNames = Initialize-SelectedEnvironment $InstancePath $architecture $toolset $sdk
    $evaluation = New-Evaluation $engine $toolsVersion $InstancePath $vsVersion $Configuration $Platform
    $clForSnapshot = Get-Command cl.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    # Official MSBuild 15 implements BuildEnvironment.Mode==VisualStudio. Verify the actual IL and method token,
    # and native ExpandString must be true; conservatively treat other versions or implementations as unknown functions.
    $script:stableVisualStudioContext = $false
    if ($vsMajor -eq 15) {
        $assembly = [Microsoft.Build.Evaluation.Project].Assembly
        $method = $assembly.GetType('Microsoft.Build.Evaluation.IntrinsicFunctions').GetMethod('IsRunningFromVisualStudio', [Reflection.BindingFlags]'Static,Public,NonPublic')
        if ($method) {
            $il = $method.GetMethodBody().GetILAsByteArray()
            # Release IL is 14 bytes: call instance, callvirt mode, ldc.i4.0, ceq, ret.
            if ($il.Length -eq 14 -and $il[0] -eq 0x28 -and $il[5] -eq 0x6f -and $il[10] -eq 0x16 -and $il[11] -eq 0xfe -and $il[12] -eq 0x01 -and $il[13] -eq 0x2a) {
                $instanceMethod = $method.Module.ResolveMethod([BitConverter]::ToInt32($il,1))
                $modeMethod = $method.Module.ResolveMethod([BitConverter]::ToInt32($il,6))
                $script:stableVisualStudioContext = $instanceMethod.DeclaringType.FullName -eq 'Microsoft.Build.Shared.BuildEnvironmentHelper' -and $instanceMethod.Name -eq 'get_Instance' -and
                    $modeMethod.DeclaringType.FullName -eq 'Microsoft.Build.Shared.BuildEnvironment' -and $modeMethod.Name -eq 'get_Mode' -and
                    $evaluation.project.ExpandString('$([MSBuild]::IsRunningFromVisualStudio())') -eq 'true'
            }
        }
    }
    $toolchainFiles = @($clForSnapshot.Source, (Join-Path $engine 'Microsoft.Build.dll'), (Join-Path $engine 'MSBuild.exe'), (Join-Path $InstancePath 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'))
    # The first phase determines only the closure; the second evaluates it in a separate collection. Both SHA values must correspond to the same parameters; never wrap old parameters in a later new hash.
    try {
        $beforeInputs = Get-InputSnapshot $evaluation.project $toolchainFiles
        $beforeProbes = Get-ImportProbes $evaluation.project
        $reloadRoots = @($evaluation.project.Xml) + @($evaluation.project.Imports | ForEach-Object { $_.ImportedProject })
        foreach ($root in $reloadRoots) { $root.Reload($false, $null) }
    } finally { $evaluation.collection.UnloadAllProjects(); $evaluation.collection.Dispose() }
    $evaluation = New-Evaluation $engine $toolsVersion $InstancePath $vsVersion $Configuration $Platform
    try {
        $project = $evaluation.project
        $afterInputs = Get-InputSnapshot $project $toolchainFiles
        $afterProbes = Get-ImportProbes $project
        if (($beforeInputs | ConvertTo-Json -Depth 8 -Compress) -ne ($afterInputs | ConvertTo-Json -Depth 8 -Compress) -or
            ($beforeProbes.probes | ConvertTo-Json -Depth 8 -Compress) -ne ($afterProbes.probes | ConvertTo-Json -Depth 8 -Compress)) { throw 'evaluation_inputs_changed' }
        if (!$beforeProbes.reusable -or !$afterProbes.reusable) {
            $privateDiagnostics.Add(@{ code='dynamic_import_revalidation'; message='A dynamic import has timing or filesystem dependencies that cannot be interpreted reliably; reevaluate on every query and disable database-cache reuse.' })
        }
        if ($project.GetPropertyValue('PlatformToolset') -ne $toolset -or $project.GetPropertyValue('WindowsTargetPlatformVersion') -ne $sdk) { throw 'unstable_toolchain_selection' }
        $cl = Get-Command cl.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $compilerRoot = [Environment]::GetEnvironmentVariable('VCToolsInstallDir')
        if (!$compilerRoot -or !$cl.Source.StartsWith($compilerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'compiler_outside_selected_toolchain' }
        $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($cl.Source)
        $msvcVersion = [string]$versionInfo.FileMajorPart + '.' + $versionInfo.FileMinorPart + '.' + $versionInfo.FileBuildPart
        $sources = @($project.GetItems('ClCompile') | ForEach-Object {
            $item = $_; $row = [ordered]@{}; foreach ($field in $compileFields) { $row[$field] = $item.GetMetadataValue($field) }; $row
        })
        $imports = @($project.Imports | ForEach-Object { $_.ImportedProject.FullPath } | Select-Object -Unique)
        # Record only external environment names referenced by actual import expressions for cache revalidation, and read only their values.
        $inputNames = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
        foreach ($inputFile in @($ProjectFile) + $imports) {
            $text = [IO.File]::ReadAllText($inputFile)
            foreach ($match in [regex]::Matches($text, '\$\(([A-Za-z_][A-Za-z0-9_]*)(?=[.)])')) {
                $name = $match.Groups[1].Value
                if ($name -notin $environmentNames) { [void]$inputNames.Add($name) }
            }
        }
        $includePath = $project.GetPropertyValue('IncludePath')
        foreach ($include in ($includePath -split ';')) {
            if (!$include.Trim()) { continue }
            if (![IO.Path]::IsPathRooted($include) -or !(Test-Path -LiteralPath $include -PathType Container)) { throw 'invalid_evaluated_include_path' }
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $toolchainIdentity = $InstancePath + '|' + $InstanceVersion + '|' + $toolset + '|' + $sdk + '|' + $msvcVersion + '|' + $includePath
            $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($toolchainIdentity)))).Replace('-','').ToLowerInvariant()
        } finally { $sha.Dispose() }
        Complete-Result ([ordered]@{
            status='ready'; project=$project.FullPath; configuration=$Configuration; platform=$Platform; toolset=$toolset; sdk=$sdk;
            cl=$cl.Source; msvcVersion=$msvcVersion; includePath=$includePath; characterSet=$project.GetPropertyValue('CharacterSet');
            clOptions=[Environment]::GetEnvironmentVariable('CL'); trailingClOptions=[Environment]::GetEnvironmentVariable('_CL_');
            imports=$imports; sources=$sources; environmentNames=@($inputNames | ForEach-Object { $_ }); toolchainFingerprint=$fingerprint;
            toolchainFiles=$toolchainFiles; inputSnapshot=$afterInputs; importProbes=$afterProbes.probes; cacheReusable=($beforeProbes.reusable -and $afterProbes.reusable); importUncertainties=$afterProbes.uncertainties;
            diagnostics=$privateDiagnostics.ToArray()
        })
    } finally { $evaluation.collection.UnloadAllProjects(); $evaluation.collection.Dispose() }
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[a-z_]+$') { $code = 'msbuild_evaluation_failed' }
    if ($code -eq 'evaluation_inputs_changed') { Failure 'invalid' $code 'MSBuild evaluation inputs changed during evaluation; no database was published. Retry.' }
    Failure 'unsupported' $code 'The selected instance cannot reliably evaluate the project toolset, SDK, or compilation parameters; no build was run.'
}
