const fs = require('fs');
const path = require('path');
const Config = require('./config');

class FileManager {
    constructor() {
        this.baseDir = Config.get('filesDirectory');
        this.ensureDirectories();
    }

    ensureDirectories() {
        const dirs = [
            this.baseDir,
            path.join(this.baseDir, 'received'),
            path.join(this.baseDir, 'received', 'images'),
            path.join(this.baseDir, 'received', 'videos'),
            path.join(this.baseDir, 'received', 'documents'),
            path.join(this.baseDir, 'received', 'audio'),
            path.join(this.baseDir, 'sent'),
            path.join(this.baseDir, 'generated'),
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    /**
     * Get the subdirectory for a given media type
     */
    getMediaSubdir(mimetype) {
        if (!mimetype) return 'documents';
        if (mimetype.startsWith('image/')) return 'images';
        if (mimetype.startsWith('video/')) return 'videos';
        if (mimetype.startsWith('audio/')) return 'audio';
        return 'documents';
    }

    /**
     * Get file extension from mimetype
     */
    getExtension(mimetype) {
        const map = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'video/mp4': '.mp4',
            'video/3gpp': '.3gp',
            'audio/ogg': '.ogg',
            'audio/mpeg': '.mp3',
            'audio/mp4': '.m4a',
            'application/pdf': '.pdf',
            'application/msword': '.doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'application/vnd.ms-excel': '.xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
            'application/vnd.ms-powerpoint': '.ppt',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
            'text/plain': '.txt',
            'text/csv': '.csv',
            'text/html': '.html',
            'application/json': '.json',
            'application/zip': '.zip',
        };
        return map[mimetype] || '';
    }

    /**
     * Save received media file from WhatsApp
     */
    async saveReceivedMedia(buffer, mimetype, filename, senderJid) {
        const subdir = this.getMediaSubdir(mimetype);
        const timestamp = Date.now();
        const senderClean = (senderJid || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');

        // Use original filename if available, otherwise generate one
        const ext = this.getExtension(mimetype);
        const finalFilename = filename || `${senderClean}_${timestamp}${ext}`;
        const filePath = path.join(this.baseDir, 'received', subdir, finalFilename);

        fs.writeFileSync(filePath, buffer);
        console.log(`[FileManager] Saved received file: ${filePath}`);

        return {
            path: filePath,
            filename: finalFilename,
            mimetype,
            size: buffer.length,
            timestamp,
        };
    }

    /**
     * Save a generated file (from Gemini) — for text-based formats only
     */
    async saveGeneratedFile(content, filename, mimetype) {
        const filePath = path.join(this.baseDir, 'generated', filename);

        if (Buffer.isBuffer(content)) {
            fs.writeFileSync(filePath, content);
        } else {
            fs.writeFileSync(filePath, content, 'utf-8');
        }

        console.log(`[FileManager] Saved generated file: ${filePath}`);
        return {
            path: filePath,
            filename,
            mimetype,
            size: fs.statSync(filePath).size,
        };
    }

    /**
     * Create a real Excel (.xlsx) file from structured data.
     * @param {string} filename
     * @param {object} data - { title, headers: string[], rows: string[][] }
     * @returns {Promise<{path, filename, mimetype, size}>}
     */
    async createExcelFile(filename, data) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Gemini WhatsApp Bot';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet(data.title || 'Sheet1');

        // Add headers
        if (data.headers && data.headers.length > 0) {
            const headerRow = sheet.addRow(data.headers);
            headerRow.eachCell(cell => {
                cell.font = { bold: true, size: 12 };
                cell.fill = {
                    type: 'pattern', pattern: 'solid',
                    fgColor: { argb: 'FF4472C4' },
                };
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
                cell.border = {
                    bottom: { style: 'thin', color: { argb: 'FF000000' } },
                };
            });
        }

        // Add data rows
        if (data.rows && data.rows.length > 0) {
            for (const row of data.rows) {
                sheet.addRow(row);
            }
        }

        // Auto-fit column widths
        sheet.columns.forEach(col => {
            let maxLen = 10;
            col.eachCell({ includeEmpty: false }, cell => {
                const len = cell.value ? cell.value.toString().length : 0;
                if (len > maxLen) maxLen = len;
            });
            col.width = Math.min(maxLen + 4, 50);
        });

        const filePath = path.join(this.baseDir, 'generated', filename);
        await workbook.xlsx.writeFile(filePath);
        console.log(`[FileManager] Created Excel file: ${filePath}`);
        return {
            path: filePath,
            filename,
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: fs.statSync(filePath).size,
        };
    }

    /**
     * Create a real PDF file from structured content.
     * @param {string} filename
     * @param {object} data - { title, sections: [{ heading?, body }] }
     * @returns {Promise<{path, filename, mimetype, size}>}
     */
    async createPdfFile(filename, data) {
        const PDFDocument = require('pdfkit');

        return new Promise((resolve, reject) => {
            const filePath = path.join(this.baseDir, 'generated', filename);
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            // Title
            if (data.title) {
                doc.fontSize(22).font('Helvetica-Bold').text(data.title, { align: 'center' });
                doc.moveDown(1.5);
            }

            // Sections
            if (data.sections && data.sections.length > 0) {
                for (const section of data.sections) {
                    if (section.heading) {
                        doc.fontSize(14).font('Helvetica-Bold').text(section.heading);
                        doc.moveDown(0.5);
                    }
                    if (section.body) {
                        doc.fontSize(11).font('Helvetica').text(section.body, { lineGap: 4 });
                        doc.moveDown(1);
                    }
                }
            }

            doc.end();
            stream.on('finish', () => {
                console.log(`[FileManager] Created PDF file: ${filePath}`);
                resolve({
                    path: filePath,
                    filename,
                    mimetype: 'application/pdf',
                    size: fs.statSync(filePath).size,
                });
            });
            stream.on('error', reject);
        });
    }

    /**
     * Create a real PowerPoint (.pptx) file from structured content.
     * @param {string} filename
     * @param {object} data - { title, slides: [{ title, content }] }
     * @returns {Promise<{path, filename, mimetype, size}>}
     */
    async createPptxFile(filename, data) {
        const PptxGenJS = require('pptxgenjs');
        const pres = new PptxGenJS();
        pres.author = 'Gemini WhatsApp Bot';

        // Title slide
        if (data.title) {
            const titleSlide = pres.addSlide();
            titleSlide.addText(data.title, {
                x: 0.5, y: 1.5, w: '90%', h: 2,
                fontSize: 36, bold: true, color: '363636',
                align: 'center', valign: 'middle',
            });
        }

        // Content slides
        if (data.slides && data.slides.length > 0) {
            for (const slideData of data.slides) {
                const slide = pres.addSlide();
                if (slideData.title) {
                    slide.addText(slideData.title, {
                        x: 0.5, y: 0.3, w: '90%', h: 0.8,
                        fontSize: 24, bold: true, color: '363636',
                    });
                }
                if (slideData.content) {
                    slide.addText(slideData.content, {
                        x: 0.5, y: 1.3, w: '90%', h: 4,
                        fontSize: 14, color: '555555',
                        lineSpacingMultiple: 1.3,
                    });
                }
            }
        }

        const filePath = path.join(this.baseDir, 'generated', filename);
        await pres.writeFile({ fileName: filePath });
        console.log(`[FileManager] Created PPTX file: ${filePath}`);
        return {
            path: filePath,
            filename,
            mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            size: fs.statSync(filePath).size,
        };
    }

    /**
     * Read a file as buffer for sending via WhatsApp
     */
    readFileAsBuffer(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        return fs.readFileSync(filePath);
    }

    /**
     * Read a file as base64 for Gemini processing
     */
    readFileAsBase64(filePath) {
        const buffer = this.readFileAsBuffer(filePath);
        return buffer.toString('base64');
    }

    /**
     * Get mime type from file extension
     */
    getMimeFromPath(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const map = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.ppt': 'application/vnd.ms-powerpoint',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            '.txt': 'text/plain',
            '.csv': 'text/csv',
            '.html': 'text/html',
            '.json': 'application/json',
        };
        return map[ext] || 'application/octet-stream';
    }

    /**
     * List received files
     */
    listReceivedFiles(type = null) {
        const baseRecvDir = path.join(this.baseDir, 'received');
        const dirs = type ? [path.join(baseRecvDir, type)] :
            ['images', 'videos', 'documents', 'audio'].map(d => path.join(baseRecvDir, d));

        const files = [];
        for (const dir of dirs) {
            if (fs.existsSync(dir)) {
                const entries = fs.readdirSync(dir);
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry);
                    const stat = fs.statSync(fullPath);
                    files.push({
                        path: fullPath,
                        filename: entry,
                        size: stat.size,
                        modified: stat.mtime,
                    });
                }
            }
        }
        return files.sort((a, b) => b.modified - a.modified);
    }

    /**
     * Cleanup old files based on retention policy
     */
    cleanupOldFiles() {
        const retentionDays = Config.get('historyRetentionDays') || 30;
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

        const allDirs = [
            path.join(this.baseDir, 'received', 'images'),
            path.join(this.baseDir, 'received', 'videos'),
            path.join(this.baseDir, 'received', 'documents'),
            path.join(this.baseDir, 'received', 'audio'),
            path.join(this.baseDir, 'generated'),
        ];

        let cleaned = 0;
        for (const dir of allDirs) {
            if (!fs.existsSync(dir)) continue;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(fullPath);
                    cleaned++;
                }
            }
        }
        if (cleaned > 0) {
            console.log(`[FileManager] Cleaned ${cleaned} old files`);
        }
        return cleaned;
    }
}

module.exports = FileManager;
