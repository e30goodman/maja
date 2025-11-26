# Инструкция по развертыванию на GitHub Pages

## Шаг 1: Создать репозиторий на GitHub

1. Зайдите на [GitHub.com](https://github.com)
2. Нажмите кнопку "+" в правом верхнем углу → "New repository"
3. Назовите репозиторий (например: `maja-html`)
4. Выберите "Public" (для бесплатного GitHub Pages)
5. НЕ добавляйте README, .gitignore или лицензию (они уже есть)
6. Нажмите "Create repository"

## Шаг 2: Инициализировать Git и загрузить код

Откройте PowerShell в папке проекта и выполните:

```powershell
# Перейти в папку проекта
cd "C:\Users\user\Desktop\Maja html"

# Инициализировать Git
git init

# Добавить все файлы
git add .

# Сделать первый коммит
git commit -m "Initial commit"

# Добавить удаленный репозиторий (замените YOUR_USERNAME на ваш GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/maja-html.git

# Загрузить код на GitHub
git branch -M main
git push -u origin main
```

## Шаг 3: Настроить GitHub Pages

1. Зайдите в ваш репозиторий на GitHub
2. Перейдите в **Settings** → **Pages**
3. В разделе **Source** выберите:
   - **Source**: `GitHub Actions`
4. Сохраните настройки

## Шаг 4: Добавить секретный ключ API (если используется)

Если ваш проект использует GEMINI_API_KEY:

1. В репозитории перейдите в **Settings** → **Secrets and variables** → **Actions**
2. Нажмите **New repository secret**
3. Имя: `GEMINI_API_KEY`
4. Значение: ваш API ключ
5. Нажмите **Add secret**

## Шаг 5: Запустить деплой

После загрузки кода на GitHub:

1. GitHub Actions автоматически запустит деплой
2. Перейдите в **Actions** в вашем репозитории
3. Дождитесь завершения workflow "Deploy to GitHub Pages"
4. После успешного деплоя ваш сайт будет доступен по адресу:
   ```
   https://YOUR_USERNAME.github.io/maja-html/
   ```

## Важно!

⚠️ **Если вы изменили имя репозитория**, обновите `base` в `maja/vite.config.ts`:

```typescript
base: process.env.NODE_ENV === 'production' ? '/ВАШЕ_ИМЯ_РЕПОЗИТОРИЯ/' : '/',
```

## Открыть сайт в браузере

После успешного деплоя просто откройте в браузере:
```
https://YOUR_USERNAME.github.io/maja-html/
```

Замените `YOUR_USERNAME` на ваш GitHub username.



