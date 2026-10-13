# Configurar o login com Google

O cadastro e o login por e-mail já funcionam sem configuração externa. O botão **Continue with Google** só fica ativo depois que você configura o OAuth do seu próprio projeto Google. Não use nem publique credenciais de outra pessoa.

## 1. Criar as credenciais

1. Entre no [Google Cloud Console](https://console.cloud.google.com/).
2. Crie ou selecione um projeto para **Pokemon Battle Royale**.
3. Abra **Google Auth Platform** (ou a tela de consentimento OAuth, dependendo da interface).
4. Configure o nome do aplicativo e o e-mail de suporte. Para testes, use o público externo e adicione sua própria conta Google em **Test users**, caso o Console peça isso.
5. Vá em **Clients / Credentials → Create client → OAuth client ID** e escolha **Web application**.
6. Em **Authorized redirect URIs**, adicione exatamente:

   `http://127.0.0.1:3210/api/auth/google/callback`

   A URL precisa coincidir com a que o servidor usa. Para o teste local, abra o jogo em `http://127.0.0.1:3210` — não misture com `http://localhost:3210`.

7. Copie o **Client ID** e o **Client secret** gerados.

Referência oficial: [Google OAuth para aplicações web](https://developers.google.com/identity/protocols/oauth2).

## 2. Configurar o servidor

Abra o PowerShell e execute:

```powershell
cd "$HOME\Documents\GitHub\pokeomn-2d-arena-plus\codigo-extraido"
Copy-Item .env.example .env
notepad .env
```

No Bloco de Notas, preencha as duas primeiras linhas com suas credenciais, mantendo a última URL exatamente igual:

```dotenv
GOOGLE_CLIENT_ID=cole-seu-client-id-aqui
GOOGLE_CLIENT_SECRET=cole-seu-client-secret-aqui
GOOGLE_REDIRECT_URI=http://127.0.0.1:3210/api/auth/google/callback
```

Salve o arquivo. **Não coloque aspas nos valores e nunca compartilhe ou envie o arquivo `.env` ao GitHub.** O repositório ignora esse arquivo para evitar publicar o segredo.

## 3. Reiniciar e entrar

1. Pare o servidor que estiver rodando com `Ctrl + C`.
2. Inicie novamente, dentro da pasta `codigo-extraido`:

   ```powershell
   node server/index.cjs --port 3210 --host 127.0.0.1 --root-dir .
   ```

3. Acesse [http://127.0.0.1:3210](http://127.0.0.1:3210), entre no jogo e clique em **SIGN IN** no canto superior direito.
4. O botão **Continue with Google** deverá estar ativo. Depois do primeiro login, abra o perfil para mudar o nome e enviar uma foto personalizada.

## Login por e-mail

Também é possível criar uma conta com nome de treinador, e-mail e senha pelo botão **CREATE ACCOUNT**. A senha deve ter pelo menos 8 caracteres e é a senha **dessa conta do jogo**, não a senha da sua conta Google/Gmail. O perfil permite trocar o nome e enviar uma imagem PNG, JPG ou WebP de até 256 KB.

## Se o jogo for publicado em um site

Não reutilize o endereço local. Configure o domínio HTTPS real como URI de redirecionamento no Google Cloud e defina o mesmo valor em `GOOGLE_REDIRECT_URI` no ambiente do servidor. O endereço deve ser idêntico nos dois lugares. Nunca envie o `GOOGLE_CLIENT_SECRET` ao navegador, a chats ou ao repositório.
