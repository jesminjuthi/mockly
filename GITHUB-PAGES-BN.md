# Mockly — GitHub Pages-এ প্রকাশ করার নিয়ম

## ১. GitHub repository তৈরি করুন

GitHub-এ নতুন একটি repository তৈরি করুন। নাম `mockly` রাখতে পারেন। GitHub Free ব্যবহার করলে repository-টি **Public** রাখুন।

## ২. ZIP-এর ফাইলগুলো আপলোড করুন

এই ZIP extract করুন। Extract করা folder-এর ভেতরের সব file ও folder নতুন repository-তে upload বা push করুন। `.github` folder-টিও অবশ্যই রাখতে হবে।

## ৩. GitHub Pages চালু করুন

Repository খুলে:

1. **Settings** → **Pages** এ যান।
2. **Build and deployment** অংশে Source হিসেবে **GitHub Actions** নির্বাচন করুন।
3. Repository-এর **Actions** tab খুলুন।
4. `Deploy Mockly to GitHub Pages` workflow শেষ হওয়া পর্যন্ত অপেক্ষা করুন।

তারপর সাইটটি সাধারণত এই ঠিকানায় পাওয়া যাবে:

`https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`

উদাহরণ: repository-এর নাম `mockly` হলে:

`https://YOUR-USERNAME.github.io/mockly/`

## পরবর্তী আপডেট

ভবিষ্যতে repository-এর `main` branch-এ কোনো পরিবর্তন push করলেই GitHub Actions স্বয়ংক্রিয়ভাবে নতুন version প্রকাশ করবে।

Mockly-এর প্রশ্নব্যাংক, পরীক্ষা ও সেটিংস GitHub-এ upload হয় না। এগুলো ব্যবহারকারীর নিজস্ব browser-এর IndexedDB storage-এ থাকে।
