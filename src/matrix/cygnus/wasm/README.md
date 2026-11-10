# Vendored `cygnus-wasm`

Built from `cygnus-core/cygnus-wasm` (verify-only bindings for MSC00FC):

    make wasm                       # in cygnus-core
    cp cygnus-wasm/pkg/{cygnus_wasm.js,cygnus_wasm.d.ts,cygnus_wasm_bg.wasm} \
       <hydrogen>/src/matrix/cygnus/wasm/

These three files are generated; do not edit them. Built from cygnus-core
`ef6f9a7` (release, `--target web`, about 195 KB). `verifyCustodianSignature`
takes the signing height as a decimal string so the full `u64` range is
representable.
