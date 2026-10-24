// The CLR assembly reader: identity, strong-name state and plug-in / workflow-activity types, on images built by
// clr-assembly-fixture.mjs, plus one real compiled assembly when dotnet is installed. Nothing is loaded.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InvalidAssembly, inspectAssembly, inspectSigningCertificate } from '../lib/clr-assembly-reader.mjs';
import { buildAssembly, fakePublicKey, certificateInspectionFixture } from './clr-assembly-fixture.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const IPLUGIN = 'Microsoft.Xrm.Sdk.IPlugin';
const ACTIVITY = 'System.Activities.CodeActivity';
const WIDGET = 'Contoso.Plugins.WidgetCheck';
// The token is the last 8 bytes of SHA-1 over the key, reversed (written independently of the reader).
const tokenOf = (key) => Buffer.from(createHash('sha1').update(key).digest()).subarray(-8).reverse().toString('hex');
const typeOf = (facts, fullName) => facts.types.find((type) => type.fullName === fullName);

describe('signing certificate inspection', () => {
  it('selects the CMS signer by issuer/serial and reads PE and NuGet signatures without executing code', () => {
    const signer = new X509Certificate(createSelfSignedCertificate({ commonName: 'Invented signer' }).cert);
    const unrelated = new X509Certificate(createSelfSignedCertificate({ commonName: 'Unrelated chain certificate' }).cert);
    const fixture = certificateInspectionFixture(signer.raw, { precedingCertificates: [unrelated.raw] });
    const facts = inspectSigningCertificate(fixture.image);
    assert.equal(facts.subject, signer.subject);
    assert.equal(facts.hash, signer.fingerprint.replaceAll(':', ''));
    assert.equal(facts.selfSigned, true);
    assert.equal(facts.certificate, signer.raw.toString('base64'));
    assert.equal(facts.encodedIssuer, fixture.encodedIssuer);
    assert.equal(facts.encodedSubject, fixture.encodedIssuer);
    const packageBytes = zipOf([{ name: '.signature.p7s', data: fixture.cms }]);
    assert.deepEqual(inspectSigningCertificate(packageBytes, { package: true }), facts);
    assert.equal(inspectSigningCertificate(buildAssembly({ publicKey: fakePublicKey })), null, 'strong naming is independent of Authenticode');
    assert.equal(inspectSigningCertificate(zipOf([{ name: 'probe.nuspec', data: Buffer.from('<package/>') }]), { package: true }), null);
  });

  it('refuses malformed PE, certificate and compressed package bounds', () => {
    assert.throws(() => inspectSigningCertificate(Buffer.alloc(64)), InvalidAssembly);
    assert.throws(() => inspectSigningCertificate(Buffer.alloc(17 * 1024 * 1024)), InvalidAssembly);
    const cert = new X509Certificate(createSelfSignedCertificate().cert);
    const { image } = certificateInspectionFixture(cert.raw);
    const optional = image.readUInt32LE(0x3c) + 24, entry = optional + (image.readUInt16LE(optional) === 0x20b ? 144 : 128);
    image.writeUInt32LE(image.length + 1, entry + 4);
    assert.throws(() => inspectSigningCertificate(image), /truncated certificate table/);
    const badCms = zipOf([{ name: '.signature.p7s', data: Buffer.from([0x30, 0x80]) }]);
    assert.throws(() => inspectSigningCertificate(badCms, { package: true }), /DER length/);
  });
});

// A plug-in with a base class of its own, a locally declared interface and activity, a nested plug-in, an external base and a helper.
const TYPES = {
  typeRefs: [IPLUGIN, ACTIVITY, 'Contoso.Other.Base'],
  typeDefs: [
    { full: IPLUGIN },
    { full: 'Contoso.Plugins.WidgetBase', interfaces: [IPLUGIN] },
    { full: WIDGET, base: 'Contoso.Plugins.WidgetBase' },
    { full: 'System.Activities.CodeActivity' },
    { full: 'Contoso.Plugins.LocalActivity', base: 'System.Activities.CodeActivity' },
    { full: 'Contoso.Plugins.RemoteActivity', base: ACTIVITY },
    { full: 'Contoso.Plugins.Outer' },
    { full: 'Contoso.Plugins.Outer+Inner', nestedIn: 'Contoso.Plugins.Outer', interfaces: [IPLUGIN] },
    { full: 'Contoso.Plugins.External', base: 'Contoso.Other.Base' },
    { full: 'Contoso.Plugins.Helper' },
  ],
};

describe('CLR assembly reader', () => {
  it('reads the identity of a strong-named assembly and the plug-in types it declares', () => {
    const facts = inspectAssembly(buildAssembly({ name: 'Contoso.Plugins', version: '2.1.0.0', culture: 'en-US', publicKey: fakePublicKey, ...TYPES }));
    assert.equal(facts.name, 'Contoso.Plugins');
    assert.equal(facts.version, '2.1.0.0');
    assert.equal(facts.major, 2);
    assert.equal(facts.minor, 1);
    assert.equal(facts.culture, 'en-US');
    assert.equal(facts.publicKeyToken, tokenOf(fakePublicKey));
    assert.equal(facts.strongNamed, true);
  });

  it('flags plug-ins through a local base, a local interface and a nested type, and activities through either base', () => {
    const facts = inspectAssembly(buildAssembly({ publicKey: fakePublicKey, ...TYPES }));
    assert.deepEqual(typeOf(facts, WIDGET), { fullName: WIDGET, isPlugin: true, isWorkflowActivity: false });
    assert.equal(typeOf(facts, 'Contoso.Plugins.WidgetBase').isPlugin, true);
    assert.equal(typeOf(facts, 'Contoso.Plugins.LocalActivity').isWorkflowActivity, true, 'a CodeActivity declared in the assembly');
    assert.equal(typeOf(facts, 'Contoso.Plugins.RemoteActivity').isWorkflowActivity, true, 'a CodeActivity referenced from outside');
    assert.equal(typeOf(facts, 'Contoso.Plugins.Outer+Inner').isPlugin, true, 'the nested name is outer+inner');
    assert.equal(typeOf(facts, 'Contoso.Plugins.Outer').isPlugin, false);
  });

  it('does not follow an external base class, and lists the helper types without flags', () => {
    const facts = inspectAssembly(buildAssembly({ publicKey: fakePublicKey, ...TYPES }));
    assert.deepEqual(typeOf(facts, 'Contoso.Plugins.External'), { fullName: 'Contoso.Plugins.External', isPlugin: false, isWorkflowActivity: false }, 'ceiling: external bases are not resolved');
    assert.deepEqual(typeOf(facts, 'Contoso.Plugins.Helper'), { fullName: 'Contoso.Plugins.Helper', isPlugin: false, isWorkflowActivity: false });
    assert.equal(facts.types.some((type) => type.fullName === '<Module>'), false, 'the module type is not listed');
  });

  it('an unsigned assembly has the neutral culture, no token and is not strong-named', () => {
    const facts = inspectAssembly(buildAssembly({ typeRefs: [IPLUGIN], typeDefs: [{ full: WIDGET, interfaces: [IPLUGIN] }] }));
    assert.equal(typeOf(facts, WIDGET).isPlugin, true, 'the SDK interface named as a TypeRef');
    assert.equal(facts.culture, 'neutral');
    assert.equal(facts.publicKeyToken, null);
    assert.equal(facts.strongNamed, false);
  });

  it('the strong-name flag without a public key is not strong-named', () => {
    const facts = inspectAssembly(buildAssembly({ publicKey: null, strongName: true, typeRefs: [IPLUGIN], typeDefs: [{ full: WIDGET, interfaces: [IPLUGIN] }] }));
    assert.equal(facts.strongNamed, false);
  });

  it('a PE32 image reads the same facts as a PE32+ image', () => {
    const options = { name: 'Contoso.Plugins', version: '3.0.0.1', culture: 'fr-FR', publicKey: fakePublicKey, ...TYPES };
    assert.deepEqual(inspectAssembly(buildAssembly({ ...options, pe32: true })), inspectAssembly(buildAssembly(options)));
  });

  it('refuses an image without the MZ header (InvalidAssembly)', () => {
    const image = buildAssembly({ typeDefs: [{ full: WIDGET }] });
    image[0] = 0;
    assert.throws(() => inspectAssembly(image), (error) => error instanceof InvalidAssembly && /MZ/.test(error.message));
  });

  it('refuses a native image without a CLI header (InvalidAssembly)', () => {
    assert.throws(() => inspectAssembly(buildAssembly({ noCli: true, typeDefs: [{ full: WIDGET }] })), (error) => error instanceof InvalidAssembly && /no CLI header/.test(error.message));
  });

  it('refuses a metadata root without the BSJB signature (InvalidAssembly)', () => {
    assert.throws(() => inspectAssembly(buildAssembly({ metadataSignature: 0x12345678, typeDefs: [{ full: WIDGET }] })), (error) => error instanceof InvalidAssembly && /metadata signature/.test(error.message));
  });

  it('refuses a truncated image with InvalidAssembly, never a range error', () => {
    const image = buildAssembly({ publicKey: fakePublicKey, ...TYPES });
    for (const cut of [1, 0x40, 0x300, 0x480 + 8, 0x480 + 60]) {
      assert.throws(() => inspectAssembly(image.subarray(0, cut)), InvalidAssembly, `cut at ${cut}`);
    }
  });

  it('refuses bytes that are not a PE image (InvalidAssembly)', () => {
    assert.throws(() => inspectAssembly(Buffer.from('Contoso plug-in, not an assembly')), InvalidAssembly);
    assert.throws(() => inspectAssembly(Buffer.alloc(0)), InvalidAssembly);
  });
});

// A real compiled plug-in: a local Microsoft.Xrm.Sdk.IPlugin and System.Activities.CodeActivity stand in for the SDK, so no
// package is needed. Skipped when dotnet is not installed.
const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const SOURCE = `namespace Microsoft.Xrm.Sdk
{
    public interface IPlugin { void Execute(System.IServiceProvider serviceProvider); }
}
namespace System.Activities
{
    public abstract class CodeActivity { protected abstract void Execute(); }
}
namespace Contoso.Plugins
{
    public class WidgetBase : Microsoft.Xrm.Sdk.IPlugin { public void Execute(System.IServiceProvider s) { } }
    public class WidgetCheck : WidgetBase { }
    public class Activity : System.Activities.CodeActivity { protected override void Execute() { } }
    public class Outer { public class Inner : Microsoft.Xrm.Sdk.IPlugin { public void Execute(System.IServiceProvider s) { } } }
    public class Helper { }
}
`;

describe('CLR assembly reader against a compiled assembly (dotnet)', () => {
  it('reads a real compiled plug-in assembly', { skip: dotnet.status !== 0 && 'dotnet is not installed', timeout: 240000 }, async () => {
    const tfm = `net${dotnet.stdout.trim().split('.')[0]}.0`; // the SDK's own target, so no package download is needed
    const dir = await mkdtemp(path.join(tmpdir(), 'paqvilo-clr-'));
    try {
      await writeFile(path.join(dir, 'Contoso.Plugins.WidgetCheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework><AssemblyName>Contoso.Plugins.WidgetCheck</AssemblyName><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><GenerateAssemblyInfo>false</GenerateAssemblyInfo></PropertyGroup></Project>`);
      await writeFile(path.join(dir, 'Types.cs'), SOURCE);
      const build = spawnSync('dotnet', ['build', '-o', path.join(dir, 'out'), '--nologo', '-v', 'q', '-nodeReuse:false', '-p:UseSharedCompilation=false'], {
        cwd: dir, encoding: 'utf8', timeout: 220000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
      });
      assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
      const facts = inspectAssembly(await readFile(path.join(dir, 'out', 'Contoso.Plugins.WidgetCheck.dll')));
      assert.equal(facts.name, 'Contoso.Plugins.WidgetCheck');
      assert.equal(facts.culture, 'neutral');
      assert.equal(facts.strongNamed, false);
      assert.equal(facts.publicKeyToken, null);
      assert.equal(typeOf(facts, WIDGET).isPlugin, true, 'derives from a plug-in base in the same assembly');
      assert.equal(typeOf(facts, 'Contoso.Plugins.Activity').isWorkflowActivity, true);
      assert.equal(typeOf(facts, 'Contoso.Plugins.Outer+Inner').isPlugin, true);
      assert.equal(typeOf(facts, 'Contoso.Plugins.Helper').isPlugin, false);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
