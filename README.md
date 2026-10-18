# ZERO-G GP

スーパーファミコン「F-ZERO」(1990) へのオマージュとして作った、オリジナルの疑似3D反重力レースゲームです。
`index.html` 1 枚で動きます（ライブラリ・画像・音声ファイル・ネット接続すべて不要）。

**▶ 遊ぶ: https://fumiakim.github.io/zero-g-gp/**

## 遊び方

`index.html` をブラウザで開くだけ。`file://` で開けない環境ではローカルサーバ経由で:

```bash
python3 -m http.server 8793 --directory zero-g-gp
```

| 操作 | キーボード | ゲームパッド |
| --- | --- | --- |
| ハンドル | ← → | 左スティック / 十字 |
| アクセル | X または ↑ | A / RT |
| ブレーキ | Z または ↓ | X / LT |
| ブースト | C または Space | B / Y |
| リーン（左/右） | A / S | LB / RB |
| ポーズ | Esc / P | START |
| 消音 / 全画面 / ヘルプ | M / F / H | |

タッチ端末では画面上にボタンが出ます（アクセルは自動）。

## ゲーム内容

- **4 マシン**: BLUE COMET（バランス）/ GOLD LYNX（加速・旋回、装甲が弱い）/ IRON BISON（重装甲・グリップ）/ RED HORNET（最高速）
- **6 コース**: NEON CITY / BLUE COAST / DUNE SEA / STORM VALLEY / FROST LINE / MAGMA FIELD
- **ギミック**: ピット（エネルギー回復）、ダッシュプレート、ジャンプ台、ラフ（減速）、アイス（滑る）、横風、地雷
- **ルール**: 5 周。POWER が 0 の状態でぶつかると大破。2 周目以降 1 周ごとにブースト(S)を獲得（最大 3）。スタートの瞬間にアクセルでロケットスタート。
- **モード**: GRAND PRIX（3 カップ × 3 クラス、周回ごとの順位制限とゴール 3 位以内、予備マシン 3 台）/ FREE RACE / TIME ATTACK（ゴースト付き）
- 記録（ベストラップ・ベストタイム・トロフィー・ゴースト）はブラウザの localStorage に保存。

## 開発メモ

`index.html` は `parts/*.js` を `dev/build.mjs` で連結して生成しています。

| ファイル | 内容 |
| --- | --- |
| `parts/font.js` | 8×8 ビットマップフォント（HUD・メニュー） |
| `parts/themes.js` | 6 テーマの地面タイル・360° 背景・パレット |
| `parts/cars.js` | マシンのローポリモデルと自前ラスタライザによるスプライト事前レンダリング |
| `parts/audio.js` | Web Audio による効果音・エンジン音・オリジナル BGM |
| `parts/core-sim.js` | コース生成、物理、AI、レース規則（DOM 非依存、Node で実行可） |
| `parts/core-render.js` | Mode 7 床・スプライト・パーティクル（1 枚のピクセルバッファに描画）と HUD |
| `parts/core-app.js` | 画面遷移、グランプリ進行、入力、セーブ |

```bash
node dev/build.mjs            # index.html を再生成
node dev/tracks.mjs           # コース形状の検証と全体図 (dev/preview/tracks.png)
node dev/sim-test.mjs all     # 全コースで AI レースを高速シミュレーション
node dev/frame-test.mjs neon 0 5 12   # 実際のゲーム画面を PNG に書き出し
node dev/balance.mjs ta       # マシン別タイム比較
node dev/test-font.mjs; node dev/test-themes.mjs; node dev/test-cars.mjs; node dev/test-audio.mjs   # モジュール単体テスト
```

ブラウザでの確認時、プレビュー画面が非表示だと `requestAnimationFrame` が止まるため、
コンソールから `APP._debug().frames(60)` で 1 秒ぶん手動で進められます（レース中は `APP._debug().scene.run`）。

内部解像度は 384×216。名称・デザイン・楽曲はすべてオリジナルです。
