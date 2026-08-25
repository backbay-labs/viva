// Plan 06 Task 5 (`DOMAIN-007`): text-as-PCM is absent from the production API.
//
// `AudioFrame::from_pcm16_text` reinterpreted UTF-8 text bytes as PCM16 samples.
// That is a fixture convenience, and it silently produced an odd-length "audio"
// buffer for any odd-length string. A runtime test cannot observe the absence of
// a constructor, so it is pinned here: this file calls it and must fail to
// compile.
//
// Every other name used below is exported by `agent_domain`, so the only thing
// this case can fail on is the deleted constructor. If the constructor is ever
// reintroduced this file compiles, trybuild reports the absence proof as broken,
// and `tests/compile_fail.rs` goes red.

use agent_domain::AudioFrame;

fn main() {
    let frame = AudioFrame::from_pcm16_text("hello");

    println!("{}", frame.pcm16_base64());
}
