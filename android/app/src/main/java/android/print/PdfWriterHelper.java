package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.File;

/**
 * Writes what a WebView would print into a PDF file, without the print dialog. The callbacks of PrintDocumentAdapter
 * can only be made from inside android.print (their constructors are package-private), hence this package.
 * The PDF is Chromium's print output: real text (selectable, searchable), links, and the page's print styles.
 */
public final class PdfWriterHelper {
    public interface Done {
        void ok(int pages);

        void fail(String why);
    }

    private PdfWriterHelper() {}

    public static void write(final PrintDocumentAdapter ad, final PrintAttributes attrs, final File out, final Done done) {
        write(ad, attrs, out, new PageRange[] { PageRange.ALL_PAGES }, done);
    }

    /** Pages first..last (0-based, inclusive) only. */
    public static void write(final PrintDocumentAdapter ad, final PrintAttributes attrs, final File out, final int first, final int last, final Done done) {
        write(ad, attrs, out, new PageRange[] { new PageRange(first, last) }, done);
    }

    private static void write(final PrintDocumentAdapter ad, final PrintAttributes attrs, final File out, final PageRange[] ranges, final Done done) {
        try {
            ad.onStart();
        } catch (Exception ignored) {
        }
        ad.onLayout(null, attrs, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                final ParcelFileDescriptor fd;
                try {
                    fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE);
                } catch (Exception e) {
                    done.fail("could not create the file: " + e.getMessage());
                    return;
                }
                ad.onWrite(ranges, fd, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        try {
                            fd.close();
                        } catch (Exception ignored) {
                        }
                        try {
                            ad.onFinish();
                        } catch (Exception ignored) {
                        }
                        done.ok(info == null ? -1 : info.getPageCount());
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        try {
                            fd.close();
                        } catch (Exception ignored) {
                        }
                        done.fail("writing failed: " + error);
                    }

                    @Override
                    public void onWriteCancelled() {
                        done.fail("writing was cancelled");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                done.fail("layout failed: " + error);
            }

            @Override
            public void onLayoutCancelled() {
                done.fail("layout was cancelled");
            }
        }, null);
    }
}
