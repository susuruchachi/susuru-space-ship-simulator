# Android アプリ（APK）

宇宙船シミュレーターの Android アプリは、Web 版（GitHub Pages の
https://susuruchachi.github.io/susuru-space-ship-simulator/ ）を Chrome そのもので全画面表示する
Trusted Web Activity です（`android/`）。

- Chrome で動くので、Google でのログインも Web 版と同じように使えます。
- ゲームの更新は Web 版を更新するだけでアプリにも届きます。APK を作り直すのは、アイコンや名前を変えたいときだけです。
- 一度開けば、Web 版のサービスワーカーでオフラインでも起動できます。

## APK を作る

GitHub の **Actions → android-apk → Run workflow**。`android/` を変えて push したときも自動で作ります。
実行結果の **Artifacts** の `space-ship-simulator-apk` からダウンロードし、端末でインストールします
（「提供元不明のアプリ」の許可が必要です）。

## このアプリ専用の署名鍵（最初に一度だけ）

署名鍵が無いと、毎回ちがう使い捨ての鍵で署名されるので、作り直すたびに前のアプリを一度アンインストールしないと
上書きできません。一度作った鍵をずっと使い続けてください（なくすと、同じアプリとして更新できなくなります）。

1. Java が入っているパソコンで、鍵を作ります（パスワードは自分で決め、控えておく）。

   ```
   keytool -genkeypair -v -keystore spaceshipsim.jks -alias spaceshipsim -keyalg RSA -keysize 2048 -validity 10000
   ```

2. 鍵のファイルを base64 の文字列にします。

   ```
   base64 -w0 spaceshipsim.jks > spaceshipsim.jks.b64      # Mac は: base64 -i spaceshipsim.jks -o spaceshipsim.jks.b64
   ```

3. このリポジトリの **Settings → Secrets and variables → Actions → New repository secret** で、次の2つを登録します。

   | 名前 | 中身 |
   |---|---|
   | `SPACESIM_KEYSTORE_BASE64` | `spaceshipsim.jks.b64` の中身 |
   | `SPACESIM_KEYSTORE_PASSWORD` | 1. で決めたパスワード |

   鍵のファイル（`.jks`）はリポジトリに入れないでください。

## アプリ上部のアドレスバーを消す（任意）

アプリと Web 版のつながりを Chrome が確認できないと、画面上部にアドレスバーが出ます（動作には影響しません）。
消すには、android-apk ワークフローの実行結果の画面（Summary）に出る項目を、
`https://susuruchachi.github.io/.well-known/assetlinks.json`（`susuruchachi.github.io` リポジトリの
`.well-known/assetlinks.json`）の配列に追加します。同じドメインのほかのアプリの項目は残したまま、項目を1つ足します。
今の内容（すするanki とこのアプリの2項目）の控えは `android/assetlinks.json` にあります。
