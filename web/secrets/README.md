# Encrypted environment file

`.env.enc` is your `.env` (OpenAI key, access password, port) encrypted with
AES-256-CBC. It is safe to keep in this public repo **only because** it's
encrypted with a strong passphrase. Never commit the plaintext `.env`.

## Decrypt on the server (after `git pull`)

From the project root:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in web/secrets/.env.enc -out .env
```

It will prompt for the passphrase. Enter it once → you now have a working `.env`.
Then start the app:

```bash
pm2 start npm --name interview-supporter -- run web
pm2 save
```

## Re-encrypt after you change the key/password

When you edit `.env` locally, regenerate the encrypted file and push it:

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in .env -out web/secrets/.env.enc
git add web/secrets/.env.enc && git commit -m "Update encrypted env" && git push
```

## Change the passphrase

Just decrypt with the old passphrase, then re-encrypt with a new one using the
re-encrypt command above (it prompts for the new passphrase twice).

> Security note: because this file is public, its only protection is the
> passphrase. Keep the passphrase out of the repo, out of commit messages, and
> out of chat logs. If it ever leaks, rotate the OpenAI key immediately.
