# Vendored `cygnus-wasm`

Built from `cygnus-core/cygnus-wasm` (MSC00FC verification plus client-side
signing: identity bootstrap, device certificates, event and link signing):

    make wasm                       # in cygnus-core
    cp cygnus-wasm/pkg/{cygnus_wasm.js,cygnus_wasm.d.ts,cygnus_wasm_bg.wasm} \
       <hydrogen>/src/matrix/cygnus/wasm/

These three files are generated; do not edit them. Built from cygnus-core
`3d5d655` (release, `--target web`, about 267 KB). `verifyCustodianSignature`
takes the signing height as a decimal string so the full `u64` range is
representable.
