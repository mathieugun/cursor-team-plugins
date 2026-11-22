'use strict';

const fs = require('fs');
const path = require('path');
const { createZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
`;

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function manifestOf(pkg) {
  const deps = (pkg.extensionDependencies || []).join(',');
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escape(pkg.name)}" Version="${escape(pkg.version)}" Publisher="${escape(pkg.publisher)}"/>
    <DisplayName>${escape(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escape(pkg.description || '')}</Description>
    <Categories>${escape((pkg.categories || []).join(','))}</Categories>
    <Icon>extension/${escape(pkg.icon)}</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escape(pkg.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${escape(deps)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escape(pkg.icon)}" Addressable="true"/>
  </Assets>
</PackageManifest>
`;
}

function filesOf(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isFile()) {
      out.push(`${dir}/${e.name}`);
    }
  }
  return out;
}

function vsixEntries() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestOf(pkg)) },
  ];
  // LICENSE.txt, not LICENSE: [Content_Types].xml maps types by extension, and README.md links the file by this name
  const files = ['package.json', 'extension.js', 'README.md', 'LICENSE.txt', ...filesOf('lib'), ...filesOf('resources')];
  for (const f of files) {
    entries.push({ name: `extension/${f}`, data: fs.readFileSync(path.join(ROOT, f)) });
  }
  return entries;
}

function buildVsix(outPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = path.resolve(outPath || path.join(ROOT, 'dist', `${pkg.name}-${pkg.version}.vsix`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, createZip(vsixEntries()));
  return out;
}

module.exports = { buildVsix, vsixEntries };

if (require.main === module) {
  console.log(buildVsix(process.argv[2]));
}
