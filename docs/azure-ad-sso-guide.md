# Azure AD での SSO アプリ構成手順書

## 1. アプリ登録 (App Registration)

1. **[Azure Portal](https://portal.azure.com/)** にサインインし、検索バーで **App registrations** を検索します。
2. **New registration（新しい登録）** をクリックします。
3. 以下の情報を入力します：

   * **Name（名前）**：`xxx`（任意。プロジェクト名と一致させるのが推奨）
   * **Supported account types（サポートされるアカウントの種類）**：
     → **Accounts in this organizational directory only（この組織のディレクトリ内のアカウントのみ）** を選択
   * **Redirect URI（リダイレクト URI）**：
     種類は **Web** を選択し、バックエンドのコールバック URL を入力します。

     例：`http://localhost:8080/user/auth/callback`（開発環境）
     本番環境では必ず正式なドメイン（HTTPS）に変更してください。
4. 入力後、**Register（登録）** をクリックして登録を完了します。

## 2. 認証情報の設定

### (1) 基本情報の取得

登録完了後、**Overview（概要）** ページで以下の情報を確認できます：

* **Application (client) ID**
* **Directory (tenant) ID**
* **Object ID**

これらの値をバックエンドの `.env` ファイルに設定します：

```env
AZURE_AD_TENANT_ID=<Tenant ID>
AZURE_AD_CLIENT_ID=<Client ID>
AZURE_AD_CLIENT_SECRET=<後で生成>
AZURE_AD_REDIRECT_URI=http://localhost:8080/user/auth/callback
```

### (2) クライアントシークレットの作成

1. **Certificates & secrets（証明書とシークレット）** に移動します。
2. **Client secret（クライアントシークレット）** を新規作成します。
3. 生成された値をコピーし、`.env` に保存します。

## 3. 権限設定 (API Permissions)

1. アプリの **API permissions（API のアクセス許可）** を開きます。
2. **Add a permission（アクセス許可の追加）** → **Microsoft Graph** → **Delegated permissions** を選択します。
3. 以下の権限にチェックを入れます：

   * `openid`
   * `profile`
   * `email`
     （任意：ユーザーの組織やグループ情報が必要な場合は `User.Read` も追加）
4. **Add permissions（アクセス許可の追加）** をクリックします。

## 4. 管理者の同意 (Admin Consent)

> この手順を省略すると、ユーザーが初回ログイン時に「権限の承認」画面が表示されます。

1. **API permissions** ページで **Grant admin consent for <TenantName>** をクリックします。
2. 管理者が承認すると、その権限がテナント全体に適用されます。
3. 次回以降、ユーザーは承認画面をスキップして直接アプリにアクセスできます。

## 5. リダイレクト URI およびフロントエンド URL の設定

1. **Authentication（認証）** ページ → **Redirect URIs** にて設定します。

   * 開発環境：`http://localhost:8080/user/auth/callback`
   * 本番環境：`https://yourdomain.com/user/auth/callback`

2. 以下のオプションにチェックを入れます：

   * **Access tokens (used for implicit flows)**
   * **ID tokens (used for implicit and hybrid flows)**

3. **Front-channel logout URL（任意）**：
   フロントエンドのログアウト URL を設定します。例：
   `https://yourdomain.com/logout`

## 6. ユーザー管理（任意）

* **Azure Active Directory → Users** でユーザーを追加できます。
* ユーザーのログイン名は `User principal name (UPN)` で、
  例：`xxx@yourtenant.onmicrosoft.com` またはカスタムドメインのメールアドレスです。

## 7. SSO フローの検証

1. ユーザーが **SharePoint に設定された SSO リンク** をクリックすると、Azure のログインページにリダイレクトされます。
2. すでに Azure / SharePoint にサインインしている場合、認可コードが即時に返され、バックエンドがトークンを交換します。
3. バックエンドが `/oauth2/v2.0/token` エンドポイントを呼び出し、`id_token` を取得し、`oid`・`email`・`name` をデコードします。
4. データベースにユーザーが登録済みであれば JWT を返し、未登録の場合は自動登録し基本権限を付与します。
5. バックエンドはフロントエンドへリダイレクトします：
   `http://localhost:7000/loginSuccess?authCode=xxx`
6. フロントエンドはバックエンドの `/auth/exchange` にリクエストを送り、一時的な `authCode` をアプリ内の `app_jwt` に交換してログイン完了。

## SSOログインリンク
http://localhost:7000/login?sso=true
