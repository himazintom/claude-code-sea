# sound/

| ファイル | 内容 |
| --- | --- |
| `sea-sound.ps1` | Windows のプレーヤー。PowerShell が波音をその場で合成して再生する (画面と同じ波の予定表・潮位・場面を使う) |
| `sea-sound.sh` | macOS / Linux のプレーヤー。`sea-loop.wav` を OS の再生コマンドでループ再生する |
| `sea-loop.wav` | macOS / Linux 用の波音。480 秒 (5 場面 × 96 秒)、モノラル、11025 Hz、16 bit |

## sea-loop.wav の作り方

Windows のプレーヤーと同じ合成器から作った録音です。波の予定表 (`hooks/sea.ts` の `WAVES`) と潮位が変わったら、作り直してください。

1. `schedule.json` (予定表と潮位。モッドが `~/.claude/sea-state/` に書くもの) を用意する。
2. `powershell -File sea-sound.ps1 -StateDir <schedule.json のあるフォルダ> -Scene -1 -Volume 0.9 -DryRun loop-16k.wav` で、場面が自動で巡る 480 秒の音 (16 kHz ステレオ) を書き出す。
3. 3 回つなげて、モノラル 11025 Hz に変換する (`ffmpeg -stream_loop 2 -i loop-16k.wav -af "pan=mono|c0=0.5*c0+0.5*c1,aresample=11025" -f s16le loop-3x.raw`)。
4. 真ん中の 1 周 (480 秒) を切り出し (変換の端のなまりを避けるため)、ピークを 0.9 にそろえ、44 バイトの WAV ヘッダを付ける。

先頭 (位相 0) は、時計の 480 秒周期の頭 (UTC のエポックから 480 秒の倍数の時刻) に当たります。`sea-sound.sh` は、現在の位相までループを回転して再生します。
