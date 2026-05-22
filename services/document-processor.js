const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { calculateTokenCount } = require('./token-utils');

/**
 * Extract text from a file based on its type
 * @param {string} filePath - Path to the uploaded file
 * @param {string} fileType - 'pdf' | 'docx' | 'md' | 'txt'
 * @returns {Promise<{text: string, tokenCount: number}>}
 */
async function extractText(filePath, fileType) {
  let text = '';

  switch (fileType.toLowerCase()) {
    case 'pdf':
      const pdfBuffer = await fs.readFile(filePath);
      const pdfData = await pdfParse(pdfBuffer);
      text = pdfData.text;
      break;

    case 'docx':
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
      break;

    case 'md':
    case 'txt':
      text = await fs.readFile(filePath, 'utf-8');
      break;

    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }

  // Clean up text: normalize whitespace, remove excessive newlines
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const tokenCount = calculateTokenCount([{ content: text }]);
  return { text, tokenCount };
}

/**
 * Generate AI summary for large documents
 * @param {string} text - Full document text
 * @param {string} filename - For context in prompt
 * @param {object} openai - OpenAI client instance
 * @returns {Promise<{summary: string, tokenCount: number}>}
 */
async function generateSummary(text, filename, openai) {
  // Limit input text to prevent token overflow (roughly 15k chars ~= 4k tokens)
  const truncatedText = text.substring(0, 15000);

  const prompt = `Summarize the following document concisely, preserving key facts, skills, projects, achievements, and technical details. This summary will be used as context for job interview assistance.

Document: "${filename}"

Content:
${truncatedText}

Provide a structured summary with:
- Key qualifications/skills mentioned
- Notable projects or achievements
- Relevant experience and responsibilities
- Important technical details
- Any metrics or quantifiable results

Keep the summary under 500 words while retaining all critical information for interview context.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 700
    });

    const summary = response.choices[0].message.content.trim();
    const tokenCount = calculateTokenCount([{ content: summary }]);

    return { summary, tokenCount };
  } catch (error) {
    console.error('Failed to generate summary:', error);
    // Fallback: return truncated text if summary fails
    const fallback = text.substring(0, 2000) + '\n\n[Document truncated due to size]';
    return {
      summary: fallback,
      tokenCount: calculateTokenCount([{ content: fallback }])
    };
  }
}

/**
 * Get file extension from filename
 * @param {string} filename
 * @returns {string}
 */
function getFileType(filename) {
  return path.extname(filename).toLowerCase().slice(1);
}

/**
 * Validate if file type is supported
 * @param {string} fileType
 * @returns {boolean}
 */
function isSupported(fileType) {
  return ['pdf', 'docx', 'md', 'txt'].includes(fileType.toLowerCase());
}

module.exports = {
  extractText,
  generateSummary,
  getFileType,
  isSupported
};
