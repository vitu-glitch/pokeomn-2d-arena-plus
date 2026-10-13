# Contas de treinador e login com Google

## Criar o arquivo de configuração

No PowerShell:

\`\`\`powershell
cd "$HOME\Documents\GitHub\pokeomn-2d-arena-plus\codigo-extraido"
Copy-Item .env.example .env
notepad .env
\`\`\`

O login por e-mail e senha funciona sem configurar o Google. As contas são guardadas no diretório de salvamento do servidor; senhas são armazenadas como hashes scrypt com salt individual. Nome e foto podem ser editados no menu da conta. Fotos enviadas precisam ser PNG, JPG ou WebP e ter até 256 KB.

## Ativar o botão "Continue with Google"

1. Abra o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie ou selecione um projeto e configure a tela de consentimento OAuth.
3. Em **APIs e serviços → Credenciais**, crie um **ID do cliente OAuth** do tipo **Aplicativo da Web**.
4. Em **URIs de redirecionamento autorizados**, adicione exatamente:
   \`http://127.0.0.1:3210/api/auth/google/callback\`
5. Copie o ID e o segredo do cliente no arquivo \`.env\`:
   \`\`\`dotenv
   GOOGLE_CLIENT_ID=cole-o-id-do-cliente-aqui
   GOOGLE_CLIENT_SECRET=cole-o-segredo-do-cliente-aqui
   GOOGLE_REDIRECT_URI=http://127.0.0.1:3210/api/auth/google/callback
   \`\`\`
6. Salve o arquivo, reinicie o servidor e abra o jogo em \`http://127.0.0.1:3210\`. Não use \`localhost\` nesta configuração a menos que altere também o URI no arquivo \`.env\` e no Google Cloud Console. Os URIs precisam corresponder exatamente.

O segredo do Google fica apenas no arquivo local \`.env\`; esse arquivo está excluído do Git. **Nunca** coloque o segredo do cliente no JavaScript do navegador, em um print, nem em um commit.

## Hospedagem pública

Para um domínio público, use HTTPS e configure um URI como \`https://seu-dominio.example/api/auth/google/callback\` tanto no Google Cloud Console quanto em \`GOOGLE_REDIRECT_URI\`. Configure \`NODE_ENV=production\` e mantenha o arquivo \`.env\` fora do controle de versão. O servidor atual armazena as contas no seu diretório de salvamento local; uma hospedagem pública com vários servidores deverá usar armazenamento persistente compartilhado e uma gestão de sessão adequada à infraestrutura.

Nota: o cadastro por e-mail está disponível com e-mail e senha, mas o fluxo de confirmação de endereço e recuperação de senha por e-mail ainda precisa de um serviço de envio de e-mails.
