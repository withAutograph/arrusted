import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGeneratedRelease } from "./schema-release";

/** Real compiled platform input owned by these tests, independent of every generated app. */
export async function prepareProtectedInstallerTestRelease(root: string, scratch: string) {
  const source = path.join(scratch, "platform-fixture.cue");
  await writeFile(
    source,
    `package schema
manifest: #AppManifest & {
 app_id: "platform-fixture", customer_id: "fixture-template", version: "platform-fixture-v1"
 models: [{id:"fixture_record",label:"Fixture record",kind:"entity",fields:[
  {id:"name",label:"Name",type:"text",required:true},
 ]}]
 authorization: {
  roles:[{id:"fixture_primary",label:"Primary"},{id:"fixture_secondary",label:"Secondary"}]
  grants:[
   {role:"fixture_primary",model:"fixture_record",operations:["read","create","update","history"],read_fields:["$id","$version","name"],write_fields:["name"],record:{kind:"all"}},
   {role:"fixture_secondary",model:"fixture_record",operations:["read","create","update","history"],read_fields:["$id","$version","name"],write_fields:["name"],record:{kind:"all"}},
  ]
 }
 seed_change_sets: []
}
`,
  );
  return buildGeneratedRelease("platform-fixture", path.join(scratch, "compiled-release"), [
    "packages/schema-compiler/cue/app-manifest.cue",
    path.relative(root, source),
  ]).directory;
}
